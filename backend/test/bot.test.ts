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
  // После привязки квартиры бот отдельным сообщением приглашает в чат дома (если он есть) — сценарии
  // онбординга проверяют ответ по существу, поэтому last() пропускает приглашение (его проверяет houseChat.test).
  const isOffer = (o: Out) => /создан чат жильцов/.test(o.text);
  return { io, out, last: () => [...out].reverse().find((o) => !isOffer(o))! };
}

const U = '443346426';
const APP_LINK = (u: string, path = '') => `https://example.ru/app/${path}#t=code-for-${u}`;
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
    bot = createBot({ store, io: rec.io, logger: log, options: { now: () => new Date(clock.now), appLink: APP_LINK } });
  });

  it('полный путь: «Начать» → адрес → да → квартира → подъезд (2 нажатия + 2 ввода)', async () => {
    await bot(started());
    assert.match(rec.last().text, /Здравствуйте!.*\n[\s\S]*Напишите адрес/);

    await bot(msg('Баумана 15'));
    assert.match(rec.last().text, /Нашёл ваш дом в справочнике:\nул\. Баумана, д\. 15\nУправляющая компания: .*\(данные уточняются\)/);
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    assert.match(rec.last().text, /номер квартиры/);

    await bot(msg('42'));
    assert.match(rec.last().text, /Квартира 42\. В каком подъезде/);
    await bot(tap(button(rec.last(), '2')));

    const done = rec.last().text;
    assert.match(done, /Готово! Квартира привязана:\nул\. Баумана, д\. 15, кв\. 42, подъезд 2/);
    assert.deepEqual(rec.last().buttons.map((b) => b.text), ['Приложение с заявками', 'Сменить адрес'], 'после привязки — ровно две кнопки');
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
    assert.match(rec.last().text, /Здравствуйте![\s\S]*Нашёл ваш дом в справочнике:\nул\. Баумана, д\. 15/);
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    await bot(msg('кв 12'));
    await bot(tap(button(rec.last(), '1')));
    assert.equal(store.apartments.get(U)!.number, '12');
  });

  it('неизвестный адрес — не тупик: объяснение и выбор улицы кнопкой', async () => {
    await bot(msg('Ленина 5'));
    const o = rec.last();
    assert.match(o.text, /Такого адреса нет в справочнике[\s\S]*тестовом режиме/);
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
    assert.match(rec.last().text, /сначала укажем ваш дом[\s\S]*подадите в приложении/);
  });

  it('вернувшийся пользователь, «Сменить адрес» и «Оставить прежний»', async () => {
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '5', entrance: null });
    await bot(started());
    assert.match(rec.last().text, /С возвращением![\s\S]*в приложении/);
    await bot(tap(button(rec.last(), 'Сменить адрес')));
    assert.match(rec.last().text, /Сейчас привязана квартира:[\s\S]*останется[\s\S]*Напишите адрес/);
    await bot(tap(button(rec.last(), 'Оставить прежний адрес')));
    assert.match(rec.last().text, /Оставил прежний адрес/);
    assert.equal(store.apartments.get(U)!.number, '5');
    await bot(msg('сменить адрес'));
    await bot(msg('Пушкина 12'));
    await bot(tap(button(rec.last(), 'Да, это мой дом')));
    await bot(msg('8'));
    if (/В каком подъезде/.test(rec.last().text)) await bot(tap(button(rec.last(), 'Пропустить')));
    assert.match(rec.last().text, /Готово! Квартира привязана:\nул\. Пушкина/);
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


describe('после привязки — только две кнопки, остальное в приложении', () => {
  let store: ReturnType<typeof memoryStore>;
  let rec: ReturnType<typeof recorder>;
  const log = pino({ level: 'silent' });
  const TWO = ['Приложение с заявками', 'Сменить адрес'];
  const kbs: Button[][][] = [];

  beforeEach(() => {
    clock.now = Date.parse('2026-09-24T09:00:00Z');
    store = memoryStore();
    rec = recorder();
    kbs.length = 0;
    store.apartments.set(U, { houseId: HOUSES.find((h) => h.code === 'kzn_0018')!.id, number: '42', entrance: 2 });
  });
  const mk = (options = {}) => {
    const io: BotIO = { ...rec.io, send: async (c, t, kb) => (kbs.push(kb ?? []), rec.io.send(c, t, kb)) };
    return createBot({ store, io, logger: log, options: { now: () => new Date(clock.now), appLink: APP_LINK, ...options } });
  };

  it('любой текст, фото, /help, кнопки прежних версий — подсказка «в приложении» и те же две кнопки', async () => {
    const bot = mk();
    for (const ev of [
      msg('Течёт батарея'),
      msg('/help'),
      msg('привет'),
      { ...msg(''), attachments: [{ type: 'image', payload: { token: 't', url: 'https://x/1.jpg' } }] },
      tap('menu:list'),
      tap('req:send'),
      tap('req:solved:r1'),
    ]) {
      await bot(ev);
      assert.deepEqual(rec.last().buttons.map((b) => b.text), TWO, `${ev.type} «${ev.text ?? ev.payload}»`);
      assert.match(rec.last().text, /приложени/);
    }
    assert.equal(store.requests.length, 0, 'заявки в чате больше не создаются');
  });

  it('запах газа — памятка 104/112 сразу, и до привязки тоже', async () => {
    const bot = mk();
    await bot(msg('Пахнет газом на лестнице'));
    assert.match(rec.last().text, /104 или 112/);
    store.apartments.clear();
    await bot(msg('Сильно пахнет газом'));
    assert.match(rec.last().text, /104 или 112/);
  });

  it('кнопка приложения: open_app внутри MAX (ссылка — запасная), иначе ссылка; без адреса приложения — только «Сменить адрес»', async () => {
    await mk({ openApp: () => ({ webApp: 'my_bot', contactId: 7 }) })(msg('/start'));
    const b = kbs.at(-1)![0]![0]! as Record<string, unknown>;
    assert.equal(b.type, 'open_app');
    assert.equal(b.web_app, 'my_bot');
    assert.equal(b.fallbackUrl, 'https://example.ru/app/#t=code-for-443346426');
    await mk()(msg('/start'));
    assert.equal((kbs.at(-1)![0]![0]! as Record<string, unknown>).type, 'link');
    const noApp = createBot({ store, io: rec.io, logger: log });
    await noApp(msg('/start'));
    assert.deepEqual(rec.last().buttons.map((x) => x.text), ['Сменить адрес']);
    assert.match(rec.last().text, /Приложение сейчас недоступно/);
  });

  it('напоминание после срока: один раз, с кнопкой «Открыть заявку» на эту заявку', async () => {
    const bot = mk({ openApp: () => ({ webApp: 'my_bot' }) });
    const r = await store.createRequest(U, { address: 'a', category: 'water', description: 'Прорвало трубу', orgType: 'UK', dueAt: new Date(clock.now + 2 * 3_600_000) });
    clock.now += 119 * 60_000;
    assert.equal(await bot.remindOverdue(), 0, 'до срока не напоминаем');
    clock.now += 2 * 60_000;
    assert.equal(await bot.remindOverdue(), 1);
    assert.equal(await bot.remindOverdue(), 0, 'повторно не напоминаем');
    assert.match(rec.last().text, /^Срок по заявке REQ-2026-00001 истёк[\s\S]*Прорвало трубу[\s\S]*жалобы в Госжилинспекцию/);
    const b = kbs.at(-1)![0]![0]! as Record<string, unknown>;
    assert.equal(b.text, 'Открыть заявку');
    assert.equal(b.payload, `req_${r.id}`);
  });

  it('DEMO_DUE_MINUTES: демо-напоминание через N минут, нормативный срок не подменяется', async () => {
    const bot = mk({ demoDueMinutes: 2 });
    await store.createRequest(U, { address: 'a', category: 'roof', description: 'Протекает крыша', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    clock.now += 60_000;
    assert.equal(await bot.remindOverdue(), 0);
    clock.now += 60_000;
    assert.equal(await bot.remindOverdue(), 1);
    assert.match(rec.last().text, /^Демо-напоминание по заявке REQ-2026-00001: так бот напишет, когда истечёт нормативный срок \(25\.09, 12:00 МСК\)/);
  });
});
