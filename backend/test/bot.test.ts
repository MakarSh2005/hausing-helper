import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createBot, parseApartmentNumber, type BotIO } from '../src/bot/bot.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';
import { matchHouse } from '../src/domain/address.js';
import type { Button } from '../src/max/keyboard.js';
import type { ParsedEvent } from '../src/webhook/parser.js';

type Out = { text: string; buttons: Array<{ text: string; payload?: string }> };
function recorder() {
  const out: Out[] = [];
  const io: BotIO = {
    send: async (_chat, text, kb?: Button[][]) =>
      void out.push({ text, buttons: (kb ?? []).flat().map((b) => ({ text: b.text, payload: 'payload' in b ? b.payload : undefined })) }),
    answer: async () => {},
  };
  return { io, out, last: () => out[out.length - 1]! };
}

const U = '443346426';
let seq = 0;
const msg = (text: string): ParsedEvent => ({ type: 'message', dedupKey: `m${seq++}`, user: { userId: U }, userId: U, chatId: 'c1', text, timestamp: 1 });
const tap = (payload: string): ParsedEvent => ({ type: 'callback', dedupKey: `c${seq++}`, user: { userId: U }, userId: U, chatId: 'c1', payload, callbackId: `cb${seq}`, timestamp: 1 });
const started = (payload?: string): ParsedEvent => ({ type: 'started', dedupKey: `s${seq++}`, user: { userId: U }, userId: U, chatId: 'c1', payload, timestamp: 1 });
const button = (o: Out, label: string | RegExp) => {
  const b = o.buttons.find((x) => (typeof label === 'string' ? x.text === label : label.test(x.text)));
  assert.ok(b?.payload, `нет кнопки «${label}» среди: ${o.buttons.map((x) => x.text).join(' | ')}`);
  return b.payload!;
};

describe('справочник', () => {
  it(`все ${HOUSES.length} домов находятся по «улица номер» и без типа улицы`, () => {
    for (const h of HOUSES) {
      for (const q of [`${h.street} ${h.houseNumber}`, `${h.street.replace(/^ул\. /, '')}, д. ${h.houseNumber}`]) {
        const r = matchHouse(q, HOUSES);
        assert.ok(r.kind === 'found' && r.houses.length === 1 && r.houses[0]!.id === h.id, `${q} → ${r.kind}`);
      }
    }
  });
});

describe('онбординг', () => {
  let store: ReturnType<typeof memoryStore>;
  let rec: ReturnType<typeof recorder>;
  let bot: ReturnType<typeof createBot>;
  const log = pino({ level: 'silent' });

  beforeEach(() => {
    store = memoryStore();
    rec = recorder();
    bot = createBot({ store, io: rec.io, logger: log, options: { now: () => new Date(clock.now) } });
  });

  it('полный путь: «Начать» → адрес → да → квартира → подъезд (2 нажатия + 2 ввода)', async () => {
    await bot(started());
    assert.match(rec.last().text, /Здравствуйте!.*\n[\s\S]*Напишите адрес/);

    await bot(msg('Баумана 15'));
    assert.match(rec.last().text, /Нашёл дом:\nул\. Баумана, д\. 15\nУправляющая компания: .*\(данные уточняются\)/);
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    assert.match(rec.last().text, /номер квартиры/);

    await bot(msg('42'));
    assert.match(rec.last().text, /Квартира 42\. В каком подъезде/);
    await bot(tap(button(rec.last(), '2')));

    const done = rec.last().text;
    assert.match(done, /Готово! Квартира привязана:\nул\. Баумана, д\. 15, кв\. 42, подъезд 2/);
    assert.match(done, /Контакты УК уточняются/);
    assert.doesNotMatch(done, /\+7/, 'непроверенные телефоны не показываются');
    assert.deepEqual(store.apartments.get(U), { houseId: HOUSES.find((h) => h.code === 'kzn_0018')!.id, number: '42', entrance: 2 });
  });

  it('квартира в адресе — шаг «номер квартиры» пропускается', async () => {
    await bot(msg('ул. Баумана, д. 15, кв. 7'));
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    assert.match(rec.last().text, /Квартира 7\. В каком подъезде/);
    await bot(tap(button(rec.last(), 'Пропустить')));
    assert.match(rec.last().text, /кв\. 7\n/);
    assert.equal(store.apartments.get(U)!.entrance, null);
  });

  it('диплинк ?start=kzn_0018 сразу предлагает дом (критерий: 2 нажатия)', async () => {
    await bot(started('kzn_0018'));
    assert.match(rec.last().text, /Здравствуйте![\s\S]*Нашёл дом:\nул\. Баумана, д\. 15/);
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    await bot(msg('кв 12'));
    await bot(tap(button(rec.last(), '1')));
    assert.equal(store.apartments.get(U)!.number, '12');
  });

  it('неизвестный адрес — не тупик: объяснение и выбор улицы кнопкой', async () => {
    await bot(msg('Ленина 5'));
    const o = rec.last();
    assert.match(o.text, /Не нашёл такой адрес[\s\S]*тестовом режиме/);
    await bot(tap(button(o, 'ул. Баумана')));
    assert.match(rec.last().text, /Какой номер дома на ул\. Баумана/);
    await bot(tap(button(rec.last(), '30')));
    assert.match(rec.last().text, /ул\. Баумана, д\. 30[\s\S]*номер квартиры/);
  });

  it('номера нет на улице — предлагаем существующие', async () => {
    await bot(msg('Баумана 99'));
    assert.match(rec.last().text, /нет дома 99/);
    assert.deepEqual(rec.last().buttons.map((b) => b.text).slice(0, 4), ['10', '15', '22', '30']);
  });

  it('«нет» и «да» словами на подтверждение дома', async () => {
    await bot(msg('Баумана 15'));
    await bot(msg('нет'));
    assert.match(rec.last().text, /Напишите адрес/);
    await bot(msg('Пушкина 12'));
    await bot(msg('да'));
    assert.match(rec.last().text, /номер квартиры/);
  });

  it('неверный номер квартиры и подъезд текстом', async () => {
    await bot(msg('Баумана 15'));
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    await bot(msg('сорок два'));
    assert.match(rec.last().text, /Нужен номер квартиры цифрами/);
    await bot(msg('42'));
    await bot(msg('2'));
    assert.match(rec.last().text, /кв\. 42, подъезд 2/);
  });

  it('жалоба до привязки — объясняем, что сначала квартира', async () => {
    await bot(msg('Течёт батарея в комнате'));
    assert.match(rec.last().text, /сначала привяжем квартиру/);
  });

  it('вернувшийся пользователь, карточка квартиры, привязка другой', async () => {
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '5', entrance: null });
    await bot(started());
    assert.match(rec.last().text, /С возвращением!/);
    await bot(tap(button(rec.last(), 'Моя квартира')));
    assert.match(rec.last().text, /Ваша квартира:[\s\S]*Дом: \d{4} г\./);
    await bot(tap(button(rec.last(), 'Другая квартира')));
    assert.match(rec.last().text, /Напишите адрес/);
    await bot(msg('/start'));
    assert.match(rec.last().text, /С возвращением!/, 'старая квартира сохраняется, пока не привязана новая');
  });

  it('устаревшая кнопка подъезда — начинаем заново, а не падаем', async () => {
    await bot(tap('onb:ent:2'));
    assert.match(rec.last().text, /кнопка устарела[\s\S]*Напишите адрес/i);
  });
});

describe('номер квартиры', () => {
  it('разбор', () => {
    assert.equal(parseApartmentNumber('42'), '42');
    assert.equal(parseApartmentNumber('кв. 42'), '42');
    assert.equal(parseApartmentNumber('Квартира 15А'), '15а');
    assert.equal(parseApartmentNumber('0'), null);
    assert.equal(parseApartmentNumber('12345'), null);
    assert.equal(parseApartmentNumber('сорок'), null);
  });
});

describe('заявка', () => {
  let store: ReturnType<typeof memoryStore>;
  let rec: ReturnType<typeof recorder>;
  const log = pino({ level: 'silent' });
  const BAUMANA_15 = () => HOUSES.find((h) => h.code === 'kzn_0018')!;
  const mk = (options: Parameters<typeof createBot>[0]['options'] = {}) =>
    createBot({ store, io: rec.io, logger: log, options: { now: () => new Date(clock.now), ...options } });
  const START = Date.parse('2026-09-24T09:00:00Z'); // четверг, 12:00 МСК
  const later = (ms: number) => void (clock.now += ms);

  beforeEach(() => {
    clock.now = START;
    store = memoryStore();
    rec = recorder();
    store.apartments.set(U, { houseId: BAUMANA_15().id, number: '42', entrance: 2 });
  });

  it('«Течёт батарея» → превью → «Отправить»: номер, ответственный, срок и основание (1 сообщение + 1 нажатие)', async () => {
    const bot = mk();
    await bot(msg('Течёт батарея в комнате'));
    const pv = rec.last();
    assert.match(pv.text, /Проверьте заявку:[\s\S]*Адрес: ул\. Баумана, д\. 15, кв\. 42, подъезд 2/);
    assert.match(pv.text, /Категория: Отопление\nКому: .*\(данные уточняются\)/);
    assert.match(pv.text, /Срок по нормативу: 2 часа[\s\S]*Основание: п\. 108 Правил № 354, п\. 13 Правил № 416/);

    await bot(tap(button(pv, 'Отправить')));
    const done = rec.last().text;
    assert.match(done, /^Заявка REQ-2026-00001 зарегистрирована\./);
    assert.match(done, /Срок по нормативу: до 24\.09, 14:00 \(МСК\)/);
    assert.match(done, /тестовом режиме: заявка сохранена здесь, но в УК автоматически пока не передаётся/);
    assert.match(done, /аварийно-диспетчерскую службу вашей УК[\s\S]*112/, 'телефон непроверенной УК не показываем');
    assert.equal(store.requests.length, 1);
    assert.equal(store.requests[0]!.orgType, 'UK');
    assert.equal((await store.getSession(U)).state, 'idle');
  });

  it('категория не определилась — выбор кнопками, затем «Другая категория»', async () => {
    const bot = mk();
    await bot(msg('Хочу узнать, когда покрасят фасад дома'));
    assert.match(rec.last().text, /Не смог сам определить[\s\S]*«Хочу узнать, когда покрасят фасад дома»/);
    await bot(tap(button(rec.last(), 'Двор и территория')));
    assert.match(rec.last().text, /Категория: Двор и территория[\s\S]*10 рабочих дней[\s\S]*п\. 36 Правил № 416/);
    await bot(tap(button(rec.last(), 'Другая категория')));
    await bot(tap(button(rec.last(), 'Другое')));
    assert.match(rec.last().text, /Категория: Другое/);
    await bot(tap(button(rec.last(), 'Отправить')));
    // 10 рабочих дней от четверга 24.09 12:00 → четверг 08.10 12:00 (выходные пропущены)
    assert.match(rec.last().text, /до 08\.10, 12:00 \(МСК\)/);
    assert.equal(store.requests[0]!.category, 'other');
  });

  it('повторное «Отправить» и параллельные нажатия не создают вторую заявку', async () => {
    const bot = mk();
    await bot(msg('Не работает лифт'));
    const send = button(rec.last(), 'Отправить');
    await Promise.all([bot(tap(send)), bot(tap(send)), bot(tap(send))]);
    assert.equal(store.requests.length, 1);
    assert.match(rec.last().text, /уже отправлена или отменена/);
  });

  it('запах газа — памятка 104/112, заявка не создаётся', async () => {
    const bot = mk();
    await bot(msg('Пахнет газом на лестнице'));
    assert.match(rec.last().text, /104 или 112/);
    assert.equal(store.requests.length, 0);
    store.apartments.clear();
    await bot(msg('Сильно пахнет газом в подъезде'));
    assert.match(rec.last().text, /104 или 112/, 'и до привязки квартиры тоже');
  });

  it('проблема до привязки квартиры запоминается и возвращается после онбординга', async () => {
    store.apartments.clear();
    const bot = mk();
    await bot(msg('Засор в раковине, вода не уходит'));
    assert.match(rec.last().text, /сначала привяжем квартиру[\s\S]*запомнил/);
    await bot(msg('Баумана 15'));
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    await bot(msg('42'));
    await bot(tap(button(rec.last(), 'Пропустить')));
    const pv = rec.last().text;
    assert.match(pv, /Проверьте заявку:[\s\S]*Проблема: Засор в раковине, вода не уходит\nКатегория: Канализация, засор/);
    assert.match(rec.out[rec.out.length - 2]!.text, /Готово! Квартира привязана/);
  });

  it('вывоз мусора уходит региональному оператору ТКО', async () => {
    const bot = mk();
    await bot(msg('Не вывозят мусор третий день'));
    assert.match(rec.last().text, /Кому: региональный оператор по вывозу мусора \(ТКО\)[\s\S]*прил\. 1 к Правилам № 354, п\. 17/);
    await bot(tap(button(rec.last(), 'Отправить')));
    assert.match(rec.last().text, /Ответственный: Региональный оператор по обращению с ТКО \(демо\)\n/);
    assert.doesNotMatch(rec.last().text, /112/, 'не авария — без аварийной строки');
  });

  it('«Отмена», короткое приветствие и устаревшие кнопки', async () => {
    const bot = mk();
    await bot(msg('привет'));
    assert.match(rec.last().text, /опишите проблему одним сообщением/);
    await bot(tap('menu:request'));
    assert.match(rec.last().text, /Опишите проблему/);
    await bot(tap(button(rec.last(), 'Отмена')));
    assert.match(rec.last().text, /Заявка отменена/);
    await bot(tap('req:cancel'));
    assert.match(rec.last().text, /Нечего отменять/);
    await bot(tap('req:cat:heating'));
    assert.match(rec.last().text, /кнопка устарела/);
    assert.equal(store.requests.length, 0);
  });

  it('«Мои заявки»: пусто, демо-статусы по времени, просрочка', async () => {
    const bot = mk({ demoStatuses: true });
    await bot(tap('menu:list'));
    assert.match(rec.last().text, /Заявок пока нет/);
    await bot(msg('Не горит свет в подъезде'));
    await bot(tap(button(rec.last(), 'Отправить')));
    await bot(msg('мои заявки'));
    assert.match(rec.last().text, /REQ-2026-00001 · Свет в подъезде\n«Не горит свет в подъезде»\nСтатус: зарегистрирована · срок до 01\.10, 12:00/);
    later(31_000);
    await bot(tap(button(rec.last(), 'Мои заявки')));
    assert.match(rec.last().text, /Статус: принята \(демо\)/);
    later(8 * 24 * 3_600_000);
    await bot(tap('menu:list'));
    assert.match(rec.last().text, /Статус: в работе \(демо\) · срок истёк 01\.10, 12:00/);
  });

  it('напоминание после срока: один раз, «нет» → текст жалобы в ГЖИ, «да» → заявка закрыта', async () => {
    const bot = mk();
    await bot(msg('Прорвало трубу в ванной'));
    await bot(tap(button(rec.last(), 'Отправить')));
    later(119 * 60_000);
    assert.equal(await bot.remindOverdue(), 0, 'до срока не напоминаем');
    later(2 * 60_000);
    assert.equal(await bot.remindOverdue(), 1);
    assert.equal(await bot.remindOverdue(), 0, 'повторно не напоминаем');
    const r = rec.last();
    assert.match(r.text, /^Срок по заявке REQ-2026-00001 истёк 24\.09, 14:00 \(МСК\)\.[\s\S]*Проблема решена\?/);

    await bot(tap(button(r, 'Нет, не решена')));
    const complaint = rec.last().text;
    const intro = rec.out[rec.out.length - 2]!.text;
    assert.match(intro, /бот не передаёт заявки в УК[\s\S]*dom\.gosuslugi\.ru/);
    assert.match(complaint, /^В Государственную жилищную инспекцию Республики Татарстан/);
    assert.match(complaint, /Адрес: Казань, ул\. Баумана, д\. 15, кв\. 42, подъезд 2\n/);
    assert.match(complaint, /«Прорвало трубу в ванной»/);
    assert.match(complaint, /Правила предоставления коммунальных услуг \(утв\. постановлением Правительства РФ от 06\.05\.2011 № 354\)/);
    assert.match(complaint, /обязать управляющую организацию/);
    assert.doesNotMatch(complaint, /https?:|\+7/, 'без выдуманных ссылок и телефонов');

    await bot(tap(button(r, 'Да, решена')));
    assert.match(rec.last().text, /закрыта как решённая/);
    await bot(tap('menu:list'));
    assert.match(rec.last().text, /Статус: решена\n?/);
    assert.doesNotMatch(rec.last().text, /срок/);
  });

  it('DEMO_DUE_MINUTES: демо-напоминание через N минут, нормативный срок не подменяется', async () => {
    const bot = mk({ demoDueMinutes: 2 });
    await bot(msg('Протекает крыша'));
    await bot(tap(button(rec.last(), 'Отправить')));
    assert.match(rec.last().text, /до 25\.09, 12:00 \(МСК\)[\s\S]*Демо-режим: напомню о заявке через 2 мин/);
    later(60_000);
    assert.equal(await bot.remindOverdue(), 0);
    later(60_000);
    assert.equal(await bot.remindOverdue(), 1);
    assert.match(rec.last().text, /^Демо-напоминание по заявке REQ-2026-00001: так бот напишет, когда истечёт нормативный срок \(25\.09, 12:00 МСК\)/);
  });

  it('чужая заявка по кнопке не находится', async () => {
    const bot = mk();
    await bot(msg('Не работает лифт'));
    await bot(tap(button(rec.last(), 'Отправить')));
    const other: ParsedEvent = { ...tap('req:solved:r1'), user: { userId: 'someone' }, userId: 'someone' };
    await bot(other);
    assert.match(rec.last().text, /Заявка не найдена/);
    assert.equal(store.requests[0]!.status, 'created');
  });

  it('кнопка «Открыть в приложении» — ссылка со входом для этого жильца', async () => {
    const bot = mk({ appLink: (u, path = '') => `https://example.ru/app/${path}#t=code-for-${u}` });
    await bot(msg('Не работает лифт'));
    await bot(tap(button(rec.last(), 'Отправить')));
    assert.equal(rec.last().buttons[0]!.text, 'Заявка в приложении');
    await bot(tap('menu:list'));
    assert.equal(rec.last().buttons[0]!.text, 'Открыть в приложении');
    await bot(tap('menu:apt'));
    assert.equal(rec.last().buttons[0]!.text, 'Открыть в приложении');
    const noApp = mk();
    await noApp(tap('menu:apt'));
    assert.equal(rec.last().buttons[0]!.text, 'Подать заявку', 'без адреса приложения кнопки нет');
  });

  it('мини-приложение привязано — кнопка open_app с экраном в payload', async () => {
    const kbs: Array<Array<Array<Record<string, unknown>>>> = [];
    const bot = createBot({
      store, logger: log,
      io: { send: async (_c, _t, kb) => void kbs.push((kb ?? []) as never), answer: async () => {} },
      options: { now: () => new Date(clock.now), appLink: () => 'https://x.ru/app/#t=c', openApp: () => ({ webApp: 'my_bot', contactId: 7 }) },
    });
    await bot(msg('Не работает лифт'));
    await bot(tap('req:send'));
    const b = kbs.at(-1)![0]![0]!;
    assert.equal(b.type, 'open_app');
    assert.equal(b.web_app, 'my_bot');
    assert.equal(b.contact_id, 7);
    assert.equal(b.payload, `req_${store.requests[0]!.id}`);
    assert.equal(b.fallbackUrl, 'https://x.ru/app/#t=c');
    await bot(tap('menu:apt'));
    assert.equal(kbs.at(-1)![0]![0]!.payload, 'apartment');
  });

  it('перепривязка квартиры не меняет адрес в старых заявках', async () => {
    const bot = mk();
    await bot(msg('Не работает лифт'));
    await bot(tap(button(rec.last(), 'Отправить')));
    await bot(tap('menu:relink'));
    await bot(msg('Пушкина 12'));
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    await bot(msg('5'));
    if (/В каком подъезде/.test(rec.last().text)) await bot(tap(button(rec.last(), 'Пропустить')));
    assert.match(rec.last().text, /Пушкина/);
    const [r] = await store.listRequests(U, 5);
    assert.equal(r!.address, 'ул. Баумана, д. 15, кв. 42, подъезд 2');
    assert.equal(r!.house.street, 'ул. Баумана');
  });

  it('отзыв заявки: из «Мои заявки» → выбор → подтверждение → отозвана, напоминаний нет', async () => {
    const bot = mk();
    await bot(msg('Не работает лифт'));
    await bot(tap(button(rec.last(), 'Отправить')));
    await bot(msg('Течёт батарея'));
    await bot(tap(button(rec.last(), 'Отправить')));
    await bot(tap('menu:list'));
    await bot(tap(button(rec.last(), 'Отозвать заявку')));
    assert.match(rec.last().text, /Какую заявку отозвать/);
    assert.deepEqual(rec.last().buttons.map((b) => b.text), ['№ 2 · Отопление', '№ 1 · Лифт', 'Не отзывать']);
    await bot(tap(button(rec.last(), '№ 1 · Лифт')));
    assert.match(rec.last().text, /Отозвать заявку REQ-2026-00001\?[\s\S]*нельзя отменить/);
    await bot(tap(button(rec.last(), 'Да, отозвать')));
    assert.match(rec.last().text, /Заявка REQ-2026-00001 отозвана/);
    assert.equal(store.requests[0]!.status, 'cancelled');
    assert.equal(store.requests[1]!.status, 'created', 'вторая заявка не тронута');

    // повтор старой кнопки, «решена» по отозванной — без изменений
    await bot(tap(`req:wdok:${store.requests[0]!.id}`));
    assert.match(rec.last().text, /уже закрыта/);
    await bot(tap(`req:solved:${store.requests[0]!.id}`));
    assert.match(rec.last().text, /уже закрыта \(отозвана\)/);
    assert.equal(store.requests[0]!.status, 'cancelled');

    await bot(tap('menu:list'));
    assert.match(rec.last().text, /REQ-2026-00001 · Лифт\n«Не работает лифт»\nСтатус: отозвана\n?/);
    clock.now += 30 * 86_400_000;
    assert.equal(await bot.remindOverdue(), 1, 'напоминание только по неотозванной');
  });

  it('«Нет, оставить» и чужая заявка — ничего не меняется; текстом «отозвать» и «отмена»', async () => {
    const bot = mk();
    await bot(msg('Не работает лифт'));
    await bot(tap(button(rec.last(), 'Отправить')));
    await bot(tap(`req:wd:${store.requests[0]!.id}`));
    await bot(tap(button(rec.last(), 'Нет, оставить')));
    assert.equal(store.requests[0]!.status, 'created');
    const other: ParsedEvent = { ...tap(`req:wdok:${store.requests[0]!.id}`), user: { userId: 'чужой' }, userId: 'чужой' };
    await bot(other);
    assert.match(rec.last().text, /не найдена/);
    assert.equal(store.requests[0]!.status, 'created');
    await bot(msg('отозвать'));
    assert.match(rec.last().text, /Какую заявку отозвать/);
    await bot(msg('Течёт батарея'));
    await bot(msg('отмена'));
    assert.match(rec.last().text, /^Заявка отменена/, 'в черновике «отмена» отменяет черновик');
    assert.equal(store.requests.length, 1);
  });
});
