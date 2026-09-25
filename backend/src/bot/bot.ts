import type { Logger } from 'pino';
import { formatAddress, matchHouse, parseAddressQuery } from '../domain/address.js';
import { detectCategory } from '../domain/category.js';
import { complaintText } from '../domain/complaint.js';
import type { RequestCategory } from '../domain/enums.js';
import { CATEGORY_ORDER, computeDueAt, formatMsk, NORMS, type Norm } from '../domain/norms.js';
import { effectiveStatus, isOpen, OPEN_STATUSES, STATUS_LABEL } from '../domain/requestStatus.js';
import { describeError } from '../max/client.js';
import { btn, type Button } from '../max/keyboard.js';
import type { ParsedEvent } from '../webhook/parser.js';
import { IDLE, type ApartmentInfo, type BotStore, type HouseInfo, type OrgInfo, type RequestInfo, type Session } from './store.js';

/**
 * Сценарии бота.
 *
 * Онбординг (этап 4): адрес → подтверждение дома → номер квартиры → подъезд (можно пропустить).
 * Заявка (этап 5): описание текстом → категория (сама или кнопками) → превью → «Отправить» →
 *   номер REQ-ГГГГ-NNNNN, ответственная организация и нормативный срок. После срока бот сам
 *   спрашивает, решена ли проблема, и при «нет» даёт готовый текст жалобы в ГЖИ.
 *
 * Состояние — в user_sessions (переживает рестарт). Все ответы — обычными сообщениями:
 * всплывающие уведомления на кнопки видны не во всех клиентах MAX.
 *
 * Состояния: idle · onb.address · onb.apartment · onb.entrance · req.describe · req.category · req.confirm
 */

export interface BotIO {
  send(chatId: string, text: string, keyboard?: Button[][]): Promise<void>;
  /** Короткий ответ на нажатие (снимает «часики» на телефоне). Ошибки глотает. */
  answer(callbackId: string, notification: string): Promise<void>;
}

export interface BotOptions {
  /** MOCK_AUTO_STATUS_CHANGE: статусы «принята» / «в работе» по времени (ТЗ 5.2.4). */
  demoStatuses?: boolean;
  /** DEMO_DUE_MINUTES: напоминание через N минут вместо нормативного срока — чтобы показать сценарий просрочки. */
  demoDueMinutes?: number;
  /** Часы — подменяются в тестах. */
  now?: () => Date;
  /**
   * Ссылка «Открыть в приложении» со входом для этого пользователя (path — экран, например requests/<id>).
   * Нет PUBLIC_BASE_URL — кнопки не будет.
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
  apt: 'menu:apt',
  relink: 'menu:relink',
  request: 'menu:request', // «Подать заявку»
  list: 'menu:list', // «Мои заявки»
  cat: 'req:cat:', // + категория
  send: 'req:send',
  recat: 'req:recat',
  cancel: 'req:cancel',
  solved: 'req:solved:', // + id заявки
  unsolved: 'req:unsolved:', // + id заявки
  withdraw: 'req:withdraw', // «Отозвать заявку» — выбор из открытых
  withdrawPick: 'req:wd:', // + id — подтвердить отзыв
  withdrawYes: 'req:wdok:', // + id — отозвать
  ping: 'debug:ping',
} as const;

const ASK_ADDRESS = 'Напишите адрес вашего дома — улицу и номер.';

/** Улица без типа: «пр-кт Ибрагимова» → «Ибрагимова». */
const bareStreet = (street: string) => street.replace(/^(ул\.|пер\.|тер\.|пр-кт|б-р|пр\.|ш\.|пл\.|наб\.) /, '').replace(/ (пер\.|ул\.)$/, '');

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

/** «Авиастроительный, Вахитовский, Кировский и Московский районы». */
function districtsLine(houses: HouseInfo[]): string {
  const d = [...new Set(houses.map((h) => h.district).filter((x): x is string => !!x))].sort();
  if (d.length === 0) return 'Казани';
  if (d.length === 1) return `${d[0]} район Казани`;
  return `${d.slice(0, -1).join(', ')} и ${d.at(-1)} районы Казани`;
}
const ASK_PROBLEM =
  'Опишите проблему одним сообщением — что случилось и где.\nНапример: «Течёт батарея в комнате» или «Не горит свет на 3 этаже».';
const TEST_MODE =
  'Бот работает в тестовом режиме: заявка сохранена здесь, но в УК автоматически пока не передаётся — для этого УК должна подключиться к сервису.';
const GAS =
  'Запах газа — это опасно, здесь важны минуты.\n\n' +
  'Не включайте и не выключайте свет и электроприборы, не пользуйтесь огнём. Откройте окна, выйдите из помещения и оттуда позвоните в газовую службу по номеру 104 или 112.\n\n' +
  'Заявку о газе через бота не оформляем: её должна сразу принять аварийная газовая служба.';
const MAX_BUTTONS = 16;
const LIST_LIMIT = 5;
const MIN_DESCRIPTION = 5;
const MAX_DESCRIPTION = 1000;

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

function menuKeyboard(): Button[][] {
  return [
    [btn.callback('Подать заявку', P.request)],
    [btn.callback('Мои заявки', P.list)],
    [btn.callback('Моя квартира', P.apt), btn.callback('Другая квартира', P.relink)],
  ];
}

const cancelKeyboard = (): Button[][] => [[btn.callback('Отмена', P.cancel)]];

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

/** Кому уйдёт заявка — для превью, до создания. */
function responsibleLine(norm: Norm, house: HouseInfo): string {
  if (norm.orgType === 'TKO') return 'региональный оператор по вывозу мусора (ТКО)';
  return house.manager ? orgName(house.manager) : 'управляющая компания дома (нет в справочнике)';
}

function normLines(norm: Norm, dueAt?: Date): string[] {
  return [
    dueAt ? `Срок по нормативу: до ${formatMsk(dueAt)} (МСК)` : `Срок по нормативу: ${norm.hours ? hoursText(norm.hours) : `${norm.workingDays} рабочих дней`}`,
    `Что должно произойти: ${norm.what}`,
    `Основание: ${norm.ref}`,
  ];
}

function hoursText(h: number): string {
  if (h % 24 === 0) {
    const d = h / 24;
    return `${d} ${d === 1 ? 'сутки' : 'суток'}`;
  }
  return `${h} ${h === 1 ? 'час' : h < 5 ? 'часа' : 'часов'}`;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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

  /** Меню с кнопкой «Открыть в приложении» сверху (если мини-приложение доступно). */
  function menuWithApp(userId: string, label: string, path?: string, extra: Button[][] = []): Button[][] {
    const url = opts.appLink?.(userId, path);
    const app = opts.openApp?.();
    // Внутри MAX — кнопка мини-приложения; ссылка со входом остаётся запасной (см. router.ts).
    if (app) {
      const payload = appPayload(path);
      return [[btn.openApp(label, { ...app, ...(payload ? { payload } : {}), ...(url ? { fallbackUrl: url } : {}) })], ...extra, ...menuKeyboard()];
    }
    return url ? [[btn.link(label, url)], ...extra, ...menuKeyboard()] : [...extra, ...menuKeyboard()];
  }

  // ─── онбординг ───────────────────────────────────────────────────────────

  async function askAddress(ev: ParsedEvent, prefix?: string, pending?: string) {
    await setState(ev.userId, { state: 'onb.address', data: pending ? { pending } : {} });
    const ex = exampleAddress(await store.listHouses());
    const ask = ex ? `${ASK_ADDRESS}\nНапример: ${ex}` : ASK_ADDRESS;
    await io.send(ev.chatId, prefix ? `${prefix}\n\n${ask}` : ask);
  }

  async function confirmHouse(ev: ParsedEvent, house: HouseInfo, data: Session['data'], prefix?: string) {
    await setState(ev.userId, { state: 'onb.address', data: { ...data, houseId: house.id } });
    const lines = [
      ...(prefix ? [prefix, ''] : []),
      'Нашёл дом:',
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

    // Улица не найдена — не тупик: объясняем почему и даём выбрать улицу кнопкой.
    // Кнопками — улицы, где больше всего домов: по алфавиту первые 16 из сотни ничего не дают.
    const count = new Map<string, number>();
    for (const h of houses) count.set(h.street, (count.get(h.street) ?? 0) + 1);
    const streets = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([st]) => st);
    const looksLikeProblem = !parseAddressQuery(text).houseNumber && text.trim().split(/\s+/).length >= 2;
    const ex = exampleAddress(houses);
    const lines = [
      'Не нашёл такой адрес в справочнике.',
      `Сейчас в нём ${houses.length} ${plural(houses.length, 'дом', 'дома', 'домов')}: ${districtsLine(houses)}. Бот работает в тестовом режиме.`,
      '',
      `Проверьте написание${ex ? ` (например: ${ex})` : ''} или выберите улицу:`,
    ];
    if (looksLikeProblem) lines.unshift('Чтобы подать заявку, сначала привяжем квартиру — это нужно один раз.', '');
    await io.send(ev.chatId, lines.join('\n'), chunk(streets.map((s) => btn.callback(s, P.street + s)), 2));
  }

  async function onHouseChosen(ev: ParsedEvent, houseId: string, session: Session) {
    const house = await store.getHouse(houseId);
    const pending = session.data.pending;
    if (!house) return askAddress(ev, 'Этот дом больше не найден в справочнике.', pending);
    const apartment = session.data.apartment;
    if (apartment) return askEntrance(ev, house, apartment, pending);
    await setState(ev.userId, { state: 'onb.apartment', data: { houseId, pending } });
    await io.send(ev.chatId, `${formatAddress(house)}\n\nНапишите номер квартиры, например: 42`);
  }

  async function askEntrance(ev: ParsedEvent, house: HouseInfo, apartment: string, pending?: string) {
    const n = house.entrances ?? 0;
    if (n < 2 || n > 12) return finish(ev, house.id, apartment, null, pending);
    await setState(ev.userId, { state: 'onb.entrance', data: { houseId: house.id, apartment, pending } });
    const buttons = Array.from({ length: n }, (_, i) => btn.callback(String(i + 1), `${P.entrance}${i + 1}`));
    await io.send(ev.chatId, `Квартира ${apartment}. В каком подъезде? Это поможет УК быстрее найти вас.`, [
      ...chunk(buttons, 4),
      [btn.callback('Пропустить', `${P.entrance}skip`)],
    ]);
  }

  async function finish(ev: ParsedEvent, houseId: string, apartment: string, entrance: number | null, pending?: string) {
    await store.saveApartment(ev.userId, { houseId, number: apartment, entrance });
    await setState(ev.userId, { ...IDLE, data: {} });
    const a = await store.getApartment(ev.userId);
    if (!a) throw new Error('квартира не сохранилась');
    log.info({ userId: ev.userId, house: a.house.code }, 'bot: квартира привязана');
    const lines = ['Готово! Квартира привязана:', apartmentLine(a), ukLine(a.house), ...contactsLines(a.house)];
    if (!pending) return io.send(ev.chatId, lines.join('\n'), menuKeyboard());
    // Жилец начал с описания проблемы — возвращаемся к нему, не заставляя писать заново.
    await io.send(ev.chatId, lines.join('\n'));
    return takeDescription(ev, pending, a);
  }

  // ─── заявка ──────────────────────────────────────────────────────────────

  async function startRequest(ev: ParsedEvent) {
    const a = await store.getApartment(ev.userId);
    if (!a) return askAddress(ev, 'Чтобы подать заявку, сначала привяжем квартиру — это нужно один раз.');
    await setState(ev.userId, { state: 'req.describe', data: {} });
    await io.send(ev.chatId, ASK_PROBLEM, cancelKeyboard());
  }

  async function takeDescription(ev: ParsedEvent, text: string, a: ApartmentInfo) {
    const description = text.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
    if (description.replace(/\s/g, '').length < MIN_DESCRIPTION) {
      await setState(ev.userId, { state: 'req.describe', data: {} });
      return io.send(ev.chatId, `Опишите, пожалуйста, чуть подробнее.\n\n${ASK_PROBLEM}`, cancelKeyboard());
    }
    const category = detectCategory(description);
    if (category === 'gas') {
      await setState(ev.userId, { ...IDLE, data: {} });
      log.info({ userId: ev.userId }, 'bot: сообщение о газе — отправлена памятка');
      return io.send(ev.chatId, GAS, menuKeyboard());
    }
    if (!category) return askCategory(ev, description, 'Не смог сам определить, к чему относится проблема. Выберите категорию:');
    return preview(ev, a, description, category);
  }

  async function askCategory(ev: ParsedEvent, description: string, intro: string) {
    await setState(ev.userId, { state: 'req.category', data: { pending: description } });
    const buttons = CATEGORY_ORDER.map((c) => btn.callback(NORMS[c].title, P.cat + c));
    await io.send(ev.chatId, `${intro}\n\n«${short(description, 200)}»`, [...chunk(buttons, 2), ...cancelKeyboard()]);
  }

  async function preview(ev: ParsedEvent, a: ApartmentInfo, description: string, category: Exclude<RequestCategory, 'gas'>) {
    await setState(ev.userId, { state: 'req.confirm', data: { pending: description, category } });
    const norm = NORMS[category];
    const lines = [
      'Проверьте заявку:',
      '',
      `Адрес: ${apartmentLine(a)}`,
      `Проблема: ${description}`,
      `Категория: ${norm.title}`,
      `Кому: ${responsibleLine(norm, a.house)}`,
      ...normLines(norm),
    ];
    await io.send(ev.chatId, lines.join('\n'), [
      [btn.callback('Отправить', P.send, 'positive')],
      [btn.callback('Другая категория', P.recat), btn.callback('Отмена', P.cancel)],
    ]);
  }

  async function submit(ev: ParsedEvent, session: Session) {
    const { pending, category } = session.data;
    if (session.state !== 'req.confirm' || !pending || !category || category === 'gas') {
      return io.send(ev.chatId, 'Эта заявка уже отправлена или отменена.', menuKeyboard());
    }
    const a = await store.getApartment(ev.userId);
    if (!a) return askAddress(ev, 'Квартира не привязана — начнём с адреса.', pending);
    const norm = NORMS[category];
    const now = clock();
    // Сначала создаём, потом сбрасываем черновик: при сбое базы описание не теряется и «Отправить» можно нажать снова.
    // Двойное нажатие не создаст вторую заявку: события пользователя идут строго по очереди (см. handle),
    // и второе нажатие увидит уже сброшенное состояние.
    const r = await store.createRequest(ev.userId, {
      category, description: pending, address: apartmentLine(a), orgType: norm.orgType, dueAt: computeDueAt(norm, now),
    });
    await setState(ev.userId, { ...IDLE, data: {} });
    log.info({ userId: ev.userId, number: r.number, category }, `bot: заявка ${r.number} создана (${category})`);

    const m = a.house.manager;
    const urgent = (norm.hours ?? Infinity) <= 2;
    const lines = [
      `Заявка ${r.number} зарегистрирована.`,
      '',
      `Проблема: ${r.description}`,
      `Ответственный: ${r.org ? orgName(r.org) : responsibleLine(norm, a.house)}`,
      ...normLines(norm, r.dueAt),
      '',
      opts.demoDueMinutes
        ? `Демо-режим: напомню о заявке через ${opts.demoDueMinutes} мин, чтобы показать, что бот делает после срока.`
        : 'Если срок пройдёт, а проблема останется, — я напомню и помогу составить жалобу в Госжилинспекцию.',
      '',
      TEST_MODE,
      ...(urgent
        ? [
            m?.verified && m.dispatcherPhone
              ? `Если авария (заливает, искрит) — звоните в аварийно-диспетчерскую службу: ${m.dispatcherPhone}.`
              : 'Если авария (заливает, искрит) — звоните в аварийно-диспетчерскую службу вашей УК, а если не дозвонились — 112.',
          ]
        : []),
    ];
    await io.send(ev.chatId, lines.join('\n'), menuWithApp(ev.userId, 'Заявка в приложении', `requests/${r.id}`));
  }

  async function listRequests(ev: ParsedEvent) {
    const list = await store.listRequests(ev.userId, LIST_LIMIT);
    if (list.length === 0) {
      return io.send(ev.chatId, 'Заявок пока нет. Чтобы подать, просто опишите проблему сообщением.', menuKeyboard());
    }
    const now = clock();
    const blocks = list.map((r) => {
      const shown = effectiveStatus(r, now, !!opts.demoStatuses);
      const demoMark = shown !== r.status ? ' (демо)' : '';
      const open = OPEN_STATUSES.includes(shown);
      const due = !open ? '' : r.dueAt <= now ? ` · срок истёк ${formatMsk(r.dueAt)}` : ` · срок до ${formatMsk(r.dueAt)}`;
      const title = r.category === 'gas' ? 'Газ' : NORMS[r.category].title;
      return [`${r.number} · ${title}`, `«${short(r.description, 80)}»`, `Статус: ${STATUS_LABEL[shown]}${demoMark}${due}`].join('\n');
    });
    const head = list.length === LIST_LIMIT ? `Последние ${LIST_LIMIT} заявок:` : 'Ваши заявки:';
    const anyOpen = list.some((r) => isOpen(r.status));
    await io.send(
      ev.chatId,
      [head, ...blocks].join('\n\n'),
      menuWithApp(ev.userId, 'Открыть в приложении', undefined, anyOpen ? [[btn.callback('Отозвать заявку', P.withdraw)]] : []),
    );
  }

  // ─── отзыв заявки: выбор → подтверждение → отзыв ────────────────────────

  async function withdrawChoose(ev: ParsedEvent) {
    const open = (await store.listRequests(ev.userId, 20)).filter((r) => isOpen(r.status)).slice(0, 8);
    if (open.length === 0) return io.send(ev.chatId, 'Открытых заявок нет — отзывать нечего.', menuKeyboard());
    const title = (r: RequestInfo) => (r.category === 'gas' ? 'Газ' : NORMS[r.category].title);
    await io.send(ev.chatId, 'Какую заявку отозвать?', [
      ...open.map((r) => [btn.callback(`${r.number.replace(/^REQ-\d{4}-0*/, '№ ')} · ${title(r)}`, P.withdrawPick + r.id)]),
      [btn.callback('Не отзывать', P.list)],
    ]);
  }

  async function withdrawConfirm(ev: ParsedEvent, id: string) {
    const r = await store.getRequest(ev.userId, id);
    if (!r) return io.send(ev.chatId, 'Заявка не найдена.', menuKeyboard());
    if (!isOpen(r.status)) return io.send(ev.chatId, `Заявка ${r.number} уже закрыта (${STATUS_LABEL[r.status]}).`, menuKeyboard());
    await io.send(
      ev.chatId,
      `Отозвать заявку ${r.number}?\n«${short(r.description, 200)}»\n\nЭто действие нельзя отменить: если проблема вернётся, подайте новую заявку.`,
      [[btn.callback('Да, отозвать', P.withdrawYes + r.id, 'negative')], [btn.callback('Нет, оставить', P.list)]],
    );
  }

  async function withdraw(ev: ParsedEvent, id: string) {
    const res = await store.cancelRequest(ev.userId, id);
    if (res === 'not_found') return io.send(ev.chatId, 'Заявка не найдена.', menuKeyboard());
    const r = await store.getRequest(ev.userId, id);
    if (res === 'closed') return io.send(ev.chatId, `Заявка ${r?.number ?? ''} уже закрыта — отзывать не нужно.`, menuKeyboard());
    log.info({ userId: ev.userId, number: r?.number }, `bot: заявка ${r?.number} отозвана жильцом`);
    await io.send(ev.chatId, `Заявка ${r?.number} отозвана. Напоминаний по ней больше не будет.\nЕсли проблема вернётся — просто опишите её снова.`, menuKeyboard());
  }

  async function onSolved(ev: ParsedEvent, id: string, solved: boolean) {
    const r = await store.getRequest(ev.userId, id);
    if (!r) return io.send(ev.chatId, 'Заявка не найдена.', menuKeyboard());
    if (!isOpen(r.status)) {
      return io.send(ev.chatId, `Заявка ${r.number} уже закрыта (${STATUS_LABEL[r.status]}).`, menuKeyboard());
    }
    if (solved) {
      await store.setRequestStatus(ev.userId, id, 'completed');
      log.info({ userId: ev.userId, number: r.number }, `bot: заявка ${r.number} закрыта жильцом`);
      return io.send(ev.chatId, `Отлично! Заявка ${r.number} закрыта как решённая.`, menuKeyboard());
    }
    if (r.category === 'gas') return io.send(ev.chatId, GAS, menuKeyboard());
    const norm = NORMS[r.category];
    await io.send(
      ev.chatId,
      [
        `Жаль. По заявке ${r.number} можно пожаловаться в Государственную жилищную инспекцию Республики Татарстан.`,
        '',
        'Ниже — готовый текст. Скопируйте его и заполните поля в квадратных скобках.',
        'Важно: в тестовом режиме бот не передаёт заявки в УК. Жалоба имеет смысл, если вы обращались в УК сами — по телефону, письменно или через ГИС ЖКХ; укажите дату и способ.',
        '',
        'Подать жалобу можно через Госуслуги или ГИС ЖКХ (dom.gosuslugi.ru), либо письмом в ГЖИ.',
      ].join('\n'),
    );
    await io.send(
      ev.chatId,
      complaintText({
        description: r.description,
        address: `${r.house.fullAddress.split(',')[0]}, ${r.address}`,
        orgName: r.org ? r.org.name : null,
        norm,
        createdAt: r.createdAt,
        dueAt: r.dueAt,
      }),
      menuKeyboard(),
    );
  }

  async function remindOverdue(): Promise<number> {
    const now = clock();
    const demoMs = (opts.demoDueMinutes ?? 0) * 60_000;
    const due = await store.overdueRequests({ now, ...(demoMs ? { createdBefore: new Date(now.getTime() - demoMs) } : {}) });
    let sent = 0;
    for (const { chatId, request: r } of due) {
      // Сначала отмечаем, потом пишем: при сбое отправки напоминание потеряется, но не задвоится.
      if (!(await store.markReminded(r.id, now))) continue;
      if (!chatId) continue;
      try {
        await io.send(chatId, reminderText(r, now), [
          [btn.callback('Да, решена', P.solved + r.id, 'positive'), btn.callback('Нет, не решена', P.unsolved + r.id)],
        ]);
        sent++;
        log.info({ number: r.number }, `bot: напоминание по заявке ${r.number} отправлено`);
      } catch (err) {
        log.warn({ number: r.number, err }, `bot: не удалось отправить напоминание по заявке ${r.number}`);
      }
    }
    return sent;
  }

  function reminderText(r: RequestInfo, now: Date): string {
    const head =
      r.dueAt <= now
        ? `Срок по заявке ${r.number} истёк ${formatMsk(r.dueAt)} (МСК).`
        : `Демо-напоминание по заявке ${r.number}: так бот напишет, когда истечёт нормативный срок (${formatMsk(r.dueAt)} МСК).`;
    return [head, '', `Проблема: ${r.description}`, '', 'Проблема решена?'].join('\n');
  }

  // ─── прочие экраны ───────────────────────────────────────────────────────

  async function showApartment(ev: ParsedEvent) {
    const a = await store.getApartment(ev.userId);
    if (!a) return askAddress(ev, 'Квартира ещё не привязана.');
    const h = a.house;
    const about = [h.yearBuilt && `${h.yearBuilt} г.`, h.floors && `${h.floors} эт.`, h.entrances && `${h.entrances} подъезд.`]
      .filter(Boolean)
      .join(', ');
    const lines = [
      'Ваша квартира:',
      apartmentLine(a),
      ...(about ? [`Дом: ${about}`] : []),
      '',
      ukLine(h),
      ...contactsLines(h),
    ];
    await io.send(ev.chatId, lines.join('\n'), menuWithApp(ev.userId, 'Открыть в приложении', 'apartment'));
  }

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
      return io.send(
        ev.chatId,
        `С возвращением! Ваша квартира:\n${apartmentLine(a)}\n\nЧтобы подать заявку, просто опишите проблему сообщением.`,
        menuKeyboard(),
      );
    }
    await askAddress(ev, `${greeting}\n\nСначала привяжем вашу квартиру — это нужно один раз.`);
  }

  async function help(ev: ParsedEvent) {
    const a = await store.getApartment(ev.userId);
    const lines = [
      'Я помогаю подать заявку в управляющую компанию и слежу, чтобы вам ответили в срок.',
      '',
      '• Подать заявку — просто опишите проблему одним сообщением.',
      '• «Мои заявки» — статусы и сроки; там же можно отозвать заявку.',
      '• «Моя квартира» — адрес и управляющая компания.',
      '• /start — начать сначала. Привязанная квартира и заявки сохранятся.',
    ];
    if (!a) return askAddress(ev, `${lines.join('\n')}\n\nСначала привяжем квартиру.`, (await store.getSession(ev.userId)).data.pending);
    await io.send(ev.chatId, lines.join('\n'), menuKeyboard());
  }

  // ─── маршрутизация ───────────────────────────────────────────────────────

  async function onMessage(ev: ParsedEvent) {
    const text = (ev.text ?? '').trim();
    if (!text) return io.send(ev.chatId, 'Я понимаю только текст и кнопки. Напишите, пожалуйста, словами.');
    if (/^\/?(start|старт|начать|меню|menu)$/i.test(text)) return start(ev);
    if (/^\/?(help|помощь|справка|\?)$/i.test(text)) return help(ev);
    if (/^\/?(мои )?заявки$/i.test(text)) return listRequests(ev);
    if (/^\/?отозвать( заявку)?$/i.test(text)) return withdrawChoose(ev);

    const session = await store.getSession(ev.userId);
    const pending = session.data.pending;
    // «Отмена» словами: в черновике — отменить черновик, иначе — отозвать поданную заявку.
    if (/^(отмена|отменить|отменить заявку)$/i.test(text)) {
      if (session.state.startsWith('req.')) {
        await setState(ev.userId, { ...IDLE, data: {} });
        return io.send(ev.chatId, 'Заявка отменена.', menuKeyboard());
      }
      return withdrawChoose(ev);
    }
    if (session.state === 'onb.apartment') {
      const num = parseApartmentNumber(text);
      if (!num) return io.send(ev.chatId, 'Нужен номер квартиры цифрами, например: 42');
      const house = session.data.houseId ? await store.getHouse(session.data.houseId) : null;
      if (!house) return askAddress(ev, 'Не удалось вспомнить выбранный дом.', pending);
      return askEntrance(ev, house, num, pending);
    }
    if (session.state === 'onb.entrance' && session.data.houseId && session.data.apartment) {
      if (/^(пропустить|не знаю|нет|-)$/i.test(text)) return finish(ev, session.data.houseId, session.data.apartment, null, pending);
      const n = Number(text.replace(/\D/g, ''));
      if (/^\s*(подъезд\s*)?\d{1,2}\s*$/i.test(text) && n >= 1) {
        return finish(ev, session.data.houseId, session.data.apartment, n, pending);
      }
    }
    if (session.state === 'onb.address' && session.data.houseId) {
      // Ответ словами на «Это ваш дом?»
      if (/^(да|ага|верно|точно|мой|да,? мой( дом)?)$/i.test(text)) return onHouseChosen(ev, session.data.houseId, session);
      if (/^(нет|не мой|не тот)$/i.test(text)) return askAddress(ev, undefined, pending);
    }
    if (session.state === 'onb.address' || session.state === 'onb.entrance') return handleAddress(ev, text, session);

    const a = await store.getApartment(ev.userId);
    if (!a) {
      // Без квартиры: адрес — в онбординг; похоже на проблему — запоминаем и просим адрес.
      const r = matchHouse(text, await store.listHouses());
      const category = r.kind === 'not_found' ? detectCategory(text) : null;
      if (category === 'gas') return io.send(ev.chatId, GAS);
      if (category) {
        return askAddress(ev, 'Чтобы подать заявку, сначала привяжем квартиру — это нужно один раз. Описание проблемы я запомнил.', text);
      }
      return handleAddress(ev, text, session);
    }

    // С квартирой: любой осмысленный текст — описание проблемы (в том числе вместо нажатия кнопок).
    const words = text.split(/\s+/).length;
    if (session.state === 'idle' && words < 3 && !detectCategory(text)) {
      return io.send(ev.chatId, `Чтобы подать заявку, опишите проблему одним сообщением.\nНапример: «Течёт батарея в комнате».`, menuKeyboard());
    }
    return takeDescription(ev, text, a);
  }

  async function onCallback(ev: ParsedEvent) {
    const p = ev.payload ?? '';
    await io.answer(ev.callbackId!, 'Принято');
    const session = await store.getSession(ev.userId);

    if (p.startsWith(P.house)) return onHouseChosen(ev, p.slice(P.house.length), session);
    if (p.startsWith(P.street)) return handleAddress(ev, p.slice(P.street.length), session);
    if (p.startsWith(P.entrance)) {
      const { houseId, apartment, pending } = session.data;
      if (session.state !== 'onb.entrance' || !houseId || !apartment) {
        return askAddress(ev, 'Эта кнопка устарела — начнём привязку заново.');
      }
      const v = p.slice(P.entrance.length);
      return finish(ev, houseId, apartment, v === 'skip' ? null : Number(v) || null, pending);
    }
    if (p === P.retry) return askAddress(ev, undefined, session.data.pending);
    if (p === P.relink) return askAddress(ev);
    if (p === P.apt) return showApartment(ev);
    if (p === P.request) return startRequest(ev);
    if (p === P.list) return listRequests(ev);

    if (p.startsWith(P.cat)) {
      const category = p.slice(P.cat.length) as RequestCategory;
      const description = session.data.pending;
      const a = await store.getApartment(ev.userId);
      if (!(session.state === 'req.category' || session.state === 'req.confirm') || !description || !a || !(category in NORMS)) {
        return io.send(ev.chatId, 'Эта кнопка устарела. Опишите проблему заново.', menuKeyboard());
      }
      return preview(ev, a, description, category as Exclude<RequestCategory, 'gas'>);
    }
    if (p === P.recat) {
      if (session.state !== 'req.confirm' || !session.data.pending) {
        return io.send(ev.chatId, 'Эта кнопка устарела. Опишите проблему заново.', menuKeyboard());
      }
      return askCategory(ev, session.data.pending, 'Выберите категорию:');
    }
    if (p === P.send) return submit(ev, session);
    if (p === P.cancel) {
      if (!session.state.startsWith('req.')) return io.send(ev.chatId, 'Нечего отменять.', menuKeyboard());
      await setState(ev.userId, { ...IDLE, data: {} });
      return io.send(ev.chatId, 'Заявка отменена.', menuKeyboard());
    }
    if (p.startsWith(P.solved)) return onSolved(ev, p.slice(P.solved.length), true);
    if (p.startsWith(P.unsolved)) return onSolved(ev, p.slice(P.unsolved.length), false);
    if (p === P.withdraw) return withdrawChoose(ev);
    if (p.startsWith(P.withdrawPick)) return withdrawConfirm(ev, p.slice(P.withdrawPick.length));
    if (p.startsWith(P.withdrawYes)) return withdraw(ev, p.slice(P.withdrawYes.length));
    if (p === P.ping) return io.send(ev.chatId, 'Нажатие получено — кнопка работает ✅');

    log.info({ payload: p }, 'bot: неизвестная кнопка');
    await io.send(ev.chatId, 'Эта кнопка устарела. Напишите /start, чтобы начать заново.');
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
          menuKeyboard(),
        );
      } catch (sendErr) {
        log.error(`bot: не удалось сообщить пользователю об ошибке — ${describeError(sendErr)}`);
      }
    }
  }

  // События одного пользователя обрабатываем строго по очереди: вебхук отвечает 200 сразу,
  // и два быстрых нажатия «Отправить» иначе прочитали бы одно и то же состояние.
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
