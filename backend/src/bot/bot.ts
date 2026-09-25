import type { Logger } from 'pino';
import { formatAddress, matchHouse, parseAddressQuery } from '../domain/address.js';
import { detectCategory } from '../domain/category.js';
import { formatMsk } from '../domain/norms.js';
import { extractPhotos } from '../domain/photos.js';
import { describeError } from '../max/client.js';
import { btn, type Button } from '../max/keyboard.js';
import type { ParsedEvent } from '../webhook/parser.js';
import { IDLE, type ApartmentInfo, type BotStore, type HouseInfo, type OrgInfo, type RequestInfo, type Session } from './store.js';

/**
 * Чат-бот — «входная дверь» сервиса (решение команды 26.09):
 *   1. жилец пишет адрес, бот проверяет его по справочнику и честно говорит, нашёл ли дом;
 *   2. после привязки квартиры — две кнопки: «Приложение с заявками» и «Сменить адрес»;
 *   3. подача заявки с фото, список, отзыв, «решена / не решена», жалоба в ГЖИ — в мини-приложении.
 * Бот сам пишет жильцу, только когда истёк срок по заявке (мини-приложение не умеет присылать
 * уведомления), и на «запах газа» сразу даёт памятку 104/112 — туда нельзя отправлять в приложение.
 *
 * Состояние — в user_sessions (переживает рестарт). Состояния: idle · onb.address · onb.apartment · onb.entrance
 */

export interface BotIO {
  send(chatId: string, text: string, keyboard?: Button[][]): Promise<void>;
  /** Короткий ответ на нажатие (снимает «часики» на телефоне). Ошибки глотает. */
  answer(callbackId: string, notification: string): Promise<void>;
  /** Отправить фото по токенам MAX. */
  sendPhotos?(chatId: string, text: string, tokens: string[]): Promise<void>;
}

export interface BotOptions {
  /** DEMO_DUE_MINUTES: напоминание через N минут вместо нормативного срока — чтобы показать сценарий просрочки. */
  demoDueMinutes?: number;
  /** Часы — подменяются в тестах. */
  now?: () => Date;
  /**
   * Ссылка на мини-приложение со входом для этого пользователя (path — экран, например requests/<id>).
   * Запасной путь, если MAX не примет кнопку open_app. Нет PUBLIC_BASE_URL — ссылки нет.
   */
  appLink?: (maxUserId: string, path?: string) => string | undefined;
  /**
   * Данные для кнопки open_app (запуск мини-приложения внутри MAX): имя и user_id бота из GET /me.
   * undefined — бот ещё не проверил токен или мини-приложение не подключено: тогда кнопка-ссылка.
   */
  openApp?: () => { webApp: string; contactId?: number } | undefined;
}

/** Экран мини-приложения → start_param (только латиница, цифры, «_» и «-»). */
export function appPayload(path?: string): string | undefined {
  if (!path) return undefined;
  const m = /^requests\/([A-Za-z0-9-]+)$/.exec(path);
  if (m) return `req_${m[1]}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(path) ? path : undefined;
}

export type Bot = ((ev: ParsedEvent) => Promise<void>) & {
  /** Разослать напоминания по просроченным заявкам. Возвращает число отправленных. */
  remindOverdue(): Promise<number>;
};

const P = {
  house: 'onb:house:', // + houseId — выбран/подтверждён дом
  street: 'onb:street:', // + название улицы — выбрана улица из списка
  entrance: 'onb:ent:', // + номер подъезда | skip
  retry: 'onb:retry',
  relink: 'menu:relink', // «Сменить адрес»
  keep: 'menu:keep', // «Оставить прежний адрес»
  ping: 'debug:ping',
} as const;

const APP_BUTTON = 'Приложение с заявками';
const RELINK_BUTTON = 'Сменить адрес';
const ASK_ADDRESS = 'Напишите адрес вашего дома — улицу и номер.';
const IN_APP =
  'Заявки подаются в приложении: там можно описать проблему, приложить фото и следить за сроком. Нажмите «Приложение с заявками».';
const GAS =
  'Запах газа — это опасно, здесь важны минуты.\n\n' +
  'Не включайте и не выключайте свет и электроприборы, не пользуйтесь огнём. Откройте окна, выйдите из помещения и оттуда позвоните в газовую службу по номеру 104 или 112.\n\n' +
  'Заявку о газе через сервис не оформляем: её должна сразу принять аварийная газовая служба.';
const MAX_BUTTONS = 16;

/** Улица без типа: «пр-кт Ибрагимова» → «Ибрагимова». */
const bareStreet = (street: string) =>
  street.replace(/^(ул\.|пер\.|тер\.|пр-кт|б-р|пр\.|ш\.|пл\.|наб\.) /, '').replace(/ (пер\.|ул\.)$/, '');

/** Пример адреса из справочника (улица с наибольшим числом домов) — подсказка всегда про существующий дом. */
function exampleAddress(houses: HouseInfo[]): string | null {
  const byStreet = new Map<string, HouseInfo[]>();
  for (const h of houses) byStreet.set(h.street, [...(byStreet.get(h.street) ?? []), h]);
  const top = [...byStreet.values()].sort((a, b) => b.length - a.length)[0];
  const h = top?.find((x) => /^\d+$/.test(x.houseNumber) && !x.building) ?? top?.[0];
  return h ? `${bareStreet(h.street)} ${h.houseNumber}` : null;
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

/** «Авиастроительный, Вахитовский, Кировский и Московский районы Казани». */
function districtsLine(houses: HouseInfo[]): string {
  const d = [...new Set(houses.map((h) => h.district).filter((x): x is string => !!x))].sort();
  if (d.length === 0) return 'Казани';
  if (d.length === 1) return `${d[0]} район Казани`;
  return `${d.slice(0, -1).join(', ')} и ${d.at(-1)} районы Казани`;
}

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Название организации с честной пометкой о качестве данных. */
function orgName(o: OrgInfo): string {
  return o.verified || o.demo ? o.name : `${o.name} (данные уточняются)`;
}

function ukLine(h: HouseInfo): string {
  if (!h.manager) return 'Управляющая компания: не указана в справочнике';
  return `Управляющая компания: ${orgName(h.manager)}`;
}

function contactsLines(h: HouseInfo): string[] {
  const m = h.manager;
  if (!m) return [];
  if (!m.verified) return ['Контакты УК уточняются — покажем, как только сверим их с ГИС ЖКХ.'];
  const lines: string[] = [];
  if (m.phone) lines.push(`Телефон УК: ${m.phone}`);
  if (m.dispatcherPhone) lines.push(`Аварийно-диспетчерская служба: ${m.dispatcherPhone}`);
  if (m.workingHours) lines.push(`Часы работы: ${m.workingHours}`);
  return lines;
}

function apartmentLine(a: ApartmentInfo): string {
  return `${formatAddress(a.house)}, кв. ${a.number}${a.entrance ? `, подъезд ${a.entrance}` : ''}`;
}

/** Номер квартиры из свободного ввода: «42», «кв 42», «квартира 42а». */
export function parseApartmentNumber(text: string): string | null {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/(квартира|кв\.?|№)/g, ' ').replace(/\s+/g, '').trim();
  return /^\d{1,4}[а-я]?$/.test(t) && !/^0+$/.test(t.replace(/[а-я]$/, '')) ? t : null;
}

export function createBot(deps: { store: BotStore; io: BotIO; logger: Logger; options?: BotOptions }): Bot {
  const { store, io } = deps;
  const opts = deps.options ?? {};
  const clock = opts.now ?? (() => new Date());
  const log = deps.logger.child({ module: 'bot' });

  const setState = (userId: string, s: Session) => store.setSession(userId, s);

  /** Кнопка мини-приложения: внутри MAX — open_app; запасной путь — ссылка со входом (см. router.ts). */
  function appButton(userId: string, label: string, path?: string): Button | null {
    const url = opts.appLink?.(userId, path);
    const app = opts.openApp?.();
    if (app) {
      const payload = appPayload(path);
      return btn.openApp(label, { ...app, ...(payload ? { payload } : {}), ...(url ? { fallbackUrl: url } : {}) });
    }
    return url ? btn.link(label, url) : null;
  }

  /** Главное меню — ровно две кнопки: «Приложение с заявками» и «Сменить адрес». */
  function mainKeyboard(userId: string): Button[][] {
    const app = appButton(userId, APP_BUTTON);
    return [...(app ? [[app]] : []), [btn.callback(RELINK_BUTTON, P.relink)]];
  }

  async function home(ev: ParsedEvent, text: string) {
    const hasApp = !!appButton(ev.userId, APP_BUTTON);
    await io.send(ev.chatId, hasApp ? text : `${text}\n\nПриложение сейчас недоступно — попробуйте чуть позже.`, mainKeyboard(ev.userId));
  }

  // ─── привязка квартиры ───────────────────────────────────────────────────

  async function askAddress(ev: ParsedEvent, prefix?: string, keyboard?: Button[][]) {
    await setState(ev.userId, { state: 'onb.address', data: {} });
    const ex = exampleAddress(await store.listHouses());
    const ask = ex ? `${ASK_ADDRESS}\nНапример: ${ex}` : ASK_ADDRESS;
    await io.send(ev.chatId, prefix ? `${prefix}\n\n${ask}` : ask, keyboard);
  }

  async function confirmHouse(ev: ParsedEvent, house: HouseInfo, data: Session['data'], prefix?: string) {
    await setState(ev.userId, { state: 'onb.address', data: { ...data, houseId: house.id } });
    const lines = [
      ...(prefix ? [prefix, ''] : []),
      'Нашёл ваш дом в справочнике:',
      formatAddress(house),
      ukLine(house),
      ...(house.verified ? [] : ['', 'Справочник домов работает в тестовом режиме.']),
      '',
      'Это ваш дом?',
    ];
    await io.send(ev.chatId, lines.join('\n'), [
      [btn.callback('Да, это мой дом', P.house + house.id, 'positive')],
      [btn.callback('Нет, другой адрес', P.retry)],
    ]);
  }

  async function offerHouses(ev: ParsedEvent, text: string, houses: HouseInfo[]) {
    const shown = houses.slice(0, MAX_BUTTONS);
    const buttons = shown.map((h) =>
      btn.callback(h.building ? `${h.houseNumber} корп. ${h.building}` : h.houseNumber, P.house + h.id),
    );
    await io.send(ev.chatId, text, [...chunk(buttons, 4), [btn.callback('Другой адрес', P.retry)]]);
  }

  async function handleAddress(ev: ParsedEvent, text: string, session: Session) {
    const houses = await store.listHouses();
    const r = matchHouse(text, houses);
    const data = { ...session.data, apartment: r.query.apartment ?? session.data.apartment };

    if (r.kind === 'found' && r.houses.length === 1) return confirmHouse(ev, r.houses[0]!, data);
    await setState(ev.userId, { state: 'onb.address', data });

    if (r.kind === 'found') {
      return offerHouses(ev, `По адресу ${r.houses[0]!.street}, ${r.query.houseNumber} несколько корпусов. Выберите свой:`, r.houses);
    }
    if (r.kind === 'no_number') {
      return offerHouses(
        ev,
        `${r.street}: в справочнике нет дома ${r.query.houseNumber}.\nВыберите свой дом или напишите адрес заново:`,
        r.houses,
      );
    }
    if (r.kind === 'need_number') {
      return offerHouses(ev, `Какой номер дома на ${r.street}? Выберите или напишите:`, r.houses);
    }

    // Адреса нет в справочнике — говорим об этом прямо и даём выбрать улицу кнопкой.
    const count = new Map<string, number>();
    for (const h of houses) count.set(h.street, (count.get(h.street) ?? 0) + 1);
    const streets = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([st]) => st);
    const looksLikeProblem = !parseAddressQuery(text).houseNumber && text.trim().split(/\s+/).length >= 2;
    const ex = exampleAddress(houses);
    const lines = [
      'Такого адреса нет в справочнике.',
      `Сейчас в нём ${houses.length} ${plural(houses.length, 'дом', 'дома', 'домов')}: ${districtsLine(houses)}. Сервис работает в тестовом режиме.`,
      '',
      `Проверьте написание${ex ? ` (например: ${ex})` : ''} или выберите улицу:`,
    ];
    if (looksLikeProblem) lines.unshift('Чтобы подать заявку, сначала привяжем квартиру — это нужно один раз.', '');
    await io.send(ev.chatId, lines.join('\n'), chunk(streets.map((s) => btn.callback(s, P.street + s)), 2));
  }

  async function onHouseChosen(ev: ParsedEvent, houseId: string, session: Session) {
    const house = await store.getHouse(houseId);
    if (!house) return askAddress(ev, 'Этот дом больше не найден в справочнике.');
    const apartment = session.data.apartment;
    if (apartment) return askEntrance(ev, house, apartment);
    await setState(ev.userId, { state: 'onb.apartment', data: { houseId } });
    await io.send(ev.chatId, `${formatAddress(house)}\n\nНапишите номер квартиры, например: 42`);
  }

  async function askEntrance(ev: ParsedEvent, house: HouseInfo, apartment: string) {
    const n = house.entrances ?? 0;
    if (n < 2 || n > 12) return finish(ev, house.id, apartment, null);
    await setState(ev.userId, { state: 'onb.entrance', data: { houseId: house.id, apartment } });
    const buttons = Array.from({ length: n }, (_, i) => btn.callback(String(i + 1), `${P.entrance}${i + 1}`));
    await io.send(ev.chatId, `Квартира ${apartment}. В каком подъезде? Это поможет УК быстрее найти вас.`, [
      ...chunk(buttons, 4),
      [btn.callback('Пропустить', `${P.entrance}skip`)],
    ]);
  }

  async function finish(ev: ParsedEvent, houseId: string, apartment: string, entrance: number | null) {
    await store.saveApartment(ev.userId, { houseId, number: apartment, entrance });
    await setState(ev.userId, { ...IDLE, data: {} });
    const a = await store.getApartment(ev.userId);
    if (!a) throw new Error('квартира не сохранилась');
    log.info({ userId: ev.userId, house: a.house.code }, 'bot: квартира привязана');
    await home(
      ev,
      [
        'Готово! Квартира привязана:',
        apartmentLine(a),
        ukLine(a.house),
        ...contactsLines(a.house),
        '',
        'Подать заявку с фото и следить за ней можно в приложении.',
      ].join('\n'),
    );
  }

  /** «Сменить адрес»: старая квартира остаётся, пока не привязана новая — есть кнопка вернуться. */
  async function relink(ev: ParsedEvent) {
    const a = await store.getApartment(ev.userId);
    if (!a) return askAddress(ev);
    await askAddress(ev, `Сейчас привязана квартира: ${apartmentLine(a)}.\nОна останется, пока вы не укажете новую.`, [
      [btn.callback('Оставить прежний адрес', P.keep)],
    ]);
  }

  // ─── напоминание о сроке ─────────────────────────────────────────────────

  async function remindOverdue(): Promise<number> {
    const now = clock();
    const demoMs = (opts.demoDueMinutes ?? 0) * 60_000;
    const due = await store.overdueRequests({ now, ...(demoMs ? { createdBefore: new Date(now.getTime() - demoMs) } : {}) });
    let sent = 0;
    for (const { chatId, maxUserId, request: r } of due) {
      // Сначала отмечаем, потом пишем: при сбое отправки напоминание потеряется, но не задвоится.
      if (!(await store.markReminded(r.id, now))) continue;
      if (!chatId) continue;
      try {
        const app = appButton(maxUserId, 'Открыть заявку', `requests/${r.id}`);
        await io.send(chatId, reminderText(r, now), app ? [[app]] : undefined);
        sent++;
        log.info({ number: r.number }, `bot: напоминание по заявке ${r.number} отправлено`);
      } catch (err) {
        log.warn({ number: r.number }, `bot: не удалось отправить напоминание по заявке ${r.number} — ${describeError(err)}`);
      }
    }
    return sent;
  }

  function reminderText(r: RequestInfo, now: Date): string {
    const head =
      r.dueAt <= now
        ? `Срок по заявке ${r.number} истёк ${formatMsk(r.dueAt)} (МСК).`
        : `Демо-напоминание по заявке ${r.number}: так бот напишет, когда истечёт нормативный срок (${formatMsk(r.dueAt)} МСК).`;
    return [
      head,
      '',
      `Проблема: ${r.description}`,
      '',
      'Проблема решена? Отметьте это в заявке в приложении. Если нет — там же готовый текст жалобы в Госжилинспекцию.',
    ].join('\n');
  }

  // ─── маршрутизация ───────────────────────────────────────────────────────

  async function start(ev: ParsedEvent, payload?: string) {
    const greeting =
      'Здравствуйте! Я «Жилищный помощник».\nПомогу подать заявку в управляющую компанию и прослежу, чтобы вам ответили в срок.';
    if (payload) {
      const house = await store.getHouseByCode(payload);
      if (house) return confirmHouse(ev, house, {}, greeting);
      log.info({ payload }, 'bot: диплинк на неизвестный дом');
    }
    const a = await store.getApartment(ev.userId);
    if (a) {
      await setState(ev.userId, { ...IDLE, data: {} });
      return home(ev, `С возвращением! Ваша квартира:\n${apartmentLine(a)}\n\n${IN_APP}`);
    }
    await askAddress(ev, `${greeting}\n\nСначала укажем ваш дом — это нужно один раз.`);
  }

  async function onMessage(ev: ParsedEvent) {
    const text = (ev.text ?? '').trim();
    if (/^\/?(start|старт|начать|меню|menu)$/i.test(text)) return start(ev);

    const session = await store.getSession(ev.userId);
    const onboarding = session.state.startsWith('onb.');
    const a = onboarding ? null : await store.getApartment(ev.userId);

    // Запах газа — сразу памятка, в любом состоянии: здесь нельзя отправлять жильца в приложение.
    if (text && detectCategory(text) === 'gas') {
      return a ? home(ev, GAS) : io.send(ev.chatId, GAS);
    }

    if (!text) {
      const photo = extractPhotos(ev.attachments).length > 0;
      if (a) return home(ev, photo ? `Фото прикладываются к заявке в приложении.\n\n${IN_APP}` : IN_APP);
      return io.send(ev.chatId, onboarding ? 'Напишите, пожалуйста, текстом.' : 'Сначала укажем ваш дом — напишите адрес текстом.');
    }

    if (session.state === 'onb.apartment') {
      const num = parseApartmentNumber(text);
      if (!num) return io.send(ev.chatId, 'Нужен номер квартиры цифрами, например: 42');
      const house = session.data.houseId ? await store.getHouse(session.data.houseId) : null;
      if (!house) return askAddress(ev, 'Не удалось вспомнить выбранный дом.');
      return askEntrance(ev, house, num);
    }
    if (session.state === 'onb.entrance' && session.data.houseId && session.data.apartment) {
      if (/^(пропустить|не знаю|нет|-)$/i.test(text)) return finish(ev, session.data.houseId, session.data.apartment, null);
      const n = Number(text.replace(/\D/g, ''));
      if (/^\s*(подъезд\s*)?\d{1,2}\s*$/i.test(text) && n >= 1) return finish(ev, session.data.houseId, session.data.apartment, n);
    }
    if (session.state === 'onb.address' && session.data.houseId) {
      // Ответ словами на «Это ваш дом?»
      if (/^(да|ага|верно|точно|мой|да,? мой( дом)?)$/i.test(text)) return onHouseChosen(ev, session.data.houseId, session);
      if (/^(нет|не мой|не тот)$/i.test(text)) return askAddress(ev);
    }
    if (onboarding) return handleAddress(ev, text, session);

    // Квартира привязана: всё остальное — в приложении. «Сменить адрес» можно и словами.
    if (a) {
      if (/^\/?(сменить|другой|новый) адрес$/i.test(text)) return relink(ev);
      return home(ev, IN_APP);
    }
    // Квартиры нет: любой текст — попытка ввести адрес
    const r = matchHouse(text, await store.listHouses());
    if (r.kind === 'not_found' && detectCategory(text)) {
      return askAddress(ev, 'Чтобы подать заявку, сначала укажем ваш дом — это нужно один раз. Саму заявку подадите в приложении.');
    }
    return handleAddress(ev, text, session);
  }

  async function onCallback(ev: ParsedEvent) {
    const p = ev.payload ?? '';
    await io.answer(ev.callbackId!, 'Принято');
    const session = await store.getSession(ev.userId);

    if (p.startsWith(P.house)) return onHouseChosen(ev, p.slice(P.house.length), session);
    if (p.startsWith(P.street)) return handleAddress(ev, p.slice(P.street.length), session);
    if (p.startsWith(P.entrance)) {
      const { houseId, apartment } = session.data;
      if (session.state !== 'onb.entrance' || !houseId || !apartment) {
        return askAddress(ev, 'Эта кнопка устарела — начнём привязку заново.');
      }
      const v = p.slice(P.entrance.length);
      return finish(ev, houseId, apartment, v === 'skip' ? null : Number(v) || null);
    }
    if (p === P.retry) return askAddress(ev);
    if (p === P.relink) return relink(ev);
    if (p === P.keep) {
      const a = await store.getApartment(ev.userId);
      if (!a) return askAddress(ev);
      await setState(ev.userId, { ...IDLE, data: {} });
      return home(ev, `Оставил прежний адрес: ${apartmentLine(a)}.`);
    }
    if (p === P.ping) return io.send(ev.chatId, 'Нажатие получено — кнопка работает ✅');

    // Кнопки прежних версий («Мои заявки», «Отправить», «Да, решена»…) — теперь это в приложении.
    log.info({ payload: p }, 'bot: кнопка прежней версии или неизвестная');
    const a = await store.getApartment(ev.userId);
    if (!a) return askAddress(ev, 'Эта кнопка устарела.');
    await setState(ev.userId, { ...IDLE, data: {} });
    await home(ev, 'Эта кнопка устарела: заявки, их статусы и отзыв теперь в приложении.');
  }

  async function route(ev: ParsedEvent): Promise<void> {
    switch (ev.type) {
      case 'started':
        return start(ev, ev.payload);
      case 'message':
        return onMessage(ev);
      case 'callback':
        return onCallback(ev);
    }
  }

  // Сбой базы или MAX посреди сценария — не молчим: извиняемся и оставляем путь дальше.
  // Состояние не сбрасываем: следующая попытка продолжит с того же шага.
  async function safeRoute(ev: ParsedEvent): Promise<void> {
    try {
      await route(ev);
    } catch (err) {
      log.error({ userId: ev.userId, type: ev.type }, `bot: ошибка при обработке (${ev.type}) — ${describeError(err)}`);
      try {
        await io.send(
          ev.chatId,
          'Что-то пошло не так на нашей стороне. Попробуйте ещё раз — введённые данные сохранены.\nЕсли ошибка повторяется, напишите /start.',
          mainKeyboard(ev.userId),
        );
      } catch (sendErr) {
        log.error(`bot: не удалось сообщить пользователю об ошибке — ${describeError(sendErr)}`);
      }
    }
  }

  // События одного пользователя обрабатываем строго по очереди: вебхук отвечает 200 сразу,
  // и два быстрых нажатия иначе прочитали бы одно и то же состояние.
  const chains = new Map<string, Promise<void>>();
  const handle = (ev: ParsedEvent): Promise<void> => {
    const prev = chains.get(ev.userId) ?? Promise.resolve();
    const run = prev.then(() => safeRoute(ev));
    const tail = run.catch(() => {});
    chains.set(ev.userId, tail);
    void tail.then(() => {
      if (chains.get(ev.userId) === tail) chains.delete(ev.userId);
    });
    return run;
  };

  return Object.assign(handle, { remindOverdue });
}
