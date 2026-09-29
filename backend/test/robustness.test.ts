import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createBot, type BotIO } from '../src/bot/bot.js';
import type { Button } from '../src/max/keyboard.js';
import { submitRequest } from '../src/requests/service.js';
import type { ParsedEvent } from '../src/webhook/parser.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';

/**
 * Этап 9: «ломаем каждый шаг». Правило: на любое действие бот отвечает хотя бы одним сообщением,
 * не падает и оставляет путь дальше (кнопки или понятную подсказку).
 */

const U = '777';
let seq = 0;
const msg = (text: string, attachments: ParsedEvent['attachments'] = []): ParsedEvent => ({
  type: 'message', dedupKey: `m${seq++}`, user: { userId: U }, userId: U, chatId: 'c', text, attachments, timestamp: 1,
});
const tap = (payload: string): ParsedEvent => ({ type: 'callback', dedupKey: `c${seq++}`, user: { userId: U }, userId: U, chatId: 'c', payload, callbackId: `cb${seq}`, timestamp: 1 });
const log = pino({ level: 'silent' });
type Out = { text: string; buttons: Array<{ text: string; payload?: string }> };

function setup(opts: { failSendOnce?: boolean } = {}) {
  const store = memoryStore();
  const out: Out[] = [];
  let failSend = !!opts.failSendOnce;
  const io: BotIO = {
    send: async (_c, text, kb?: Button[][]) => {
      if (failSend) {
        failSend = false;
        throw new Error('MAX недоступен');
      }
      out.push({ text, buttons: (kb ?? []).flat().map((b) => ({ text: b.text, payload: 'payload' in b ? b.payload : undefined })) });
    },
    answer: async () => {},
  };
  const bot = createBot({
    store, io, logger: log,
    options: { now: () => new Date(clock.now), appLink: (u) => `https://example.ru/app/#t=${u}` },
  });
  const tapBtn = (label: string) => {
    const b = out.at(-1)!.buttons.find((x) => x.text === label);
    assert.ok(b?.payload, `нет кнопки «${label}»: ${out.at(-1)!.buttons.map((x) => x.text).join(' | ')}`);
    return bot(tap(b.payload!));
  };
  return { store, out, bot, tapBtn };
}

describe('устойчивость (этап 9)', () => {
  beforeEach(() => void (clock.now = Date.parse('2026-09-24T09:00:00Z')));

  it('основной сценарий: привязка в боте → три заявки подряд в приложении', async () => {
    const { store, out, bot, tapBtn } = setup();
    await bot(msg('/start'));
    await bot(msg('Баумана 15'));
    await tapBtn('Да, это мой дом');
    await bot(msg('42'));
    await tapBtn('2');
    assert.deepEqual(out.findLast((o) => /Готово!/.test(o.text))!.buttons.map((b) => b.text), ['Приложение с заявками', 'Сменить адрес']);
    for (const [description, category] of [['Течёт батарея', 'heating'], ['Не работает лифт', 'elevator'], ['Не вывозят мусор третий день', 'garbage']]) {
      const r = await submitRequest(store, U, { description: description!, category: category! }, new Date(clock.now));
      assert.ok(r.ok && !r.duplicate);
      clock.now += 60_000;
    }
    assert.deepEqual(store.requests.map((r) => r.number), ['REQ-2026-00001', 'REQ-2026-00002', 'REQ-2026-00003']);
    assert.equal(store.requests[2]!.org?.demo, true, 'мусор — региональному оператору ТКО');
  });

  it('MAX не принял ответ — бот не падает, следующее сообщение обрабатывается', async () => {
    const { out, bot } = setup({ failSendOnce: true });
    await bot(msg('/start'));
    await bot(msg('Баумана 15'));
    assert.match(out.at(-1)!.text, /Нашёл ваш дом/);
  });

  it('сбой базы — извинение и кнопки, а не молчание', async () => {
    const { store, out, bot } = setup();
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    store.getSession = async () => {
      throw new Error('SQLITE_BUSY');
    };
    await bot(msg('привет'));
    assert.match(out.at(-1)!.text, /Что-то пошло не так[\s\S]*данные сохранены/);
    assert.deepEqual(out.at(-1)!.buttons.map((b) => b.text), ['Приложение с заявками', 'Сменить адрес']);
  });

  it('мусорные нажатия и сообщения в любом состоянии — всегда ответ, ни одного исключения', async () => {
    const { out, bot, tapBtn, store } = setup();
    const junkTaps = ['', 'x', 'onb:house:', 'onb:house:no-such', 'onb:street:Несуществующая', 'onb:ent:', 'onb:ent:99',
      'menu:relink', 'menu:keep', 'menu:list', 'menu:apt', 'req:send', 'req:solved:r1', 'req:wdok:r1', 'a'.repeat(900)];
    const junkMsgs = ['', '   ', '😀😀😀', '/unknown', '/help', "'; DROP TABLE users; --", 'а'.repeat(5000), '0', 'кв 0', '12345', 'нет', 'да',
      'сменить адрес', 'Пахнет газом'];
    const photo = msg('', [{ type: 'image', payload: { token: 't', url: 'https://x/1.jpg' } }]);
    const video = msg('', [{ type: 'video', payload: {} }]);
    const states: Array<() => Promise<void>> = [
      async () => {},
      async () => void (await bot(msg('Баумана 15'))),
      async () => {
        await bot(msg('Баумана 15'));
        await tapBtn('Да, это мой дом');
      },
      async () => {
        await bot(msg('Баумана 15'));
        await tapBtn('Да, это мой дом');
        await bot(msg('42'));
      },
      async () => void store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null }),
      async () => {
        store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
        await bot(tap('menu:relink'));
      },
    ];
    for (const [i, enter] of states.entries()) {
      for (const ev of [...junkTaps.map(tap), ...junkMsgs.map((t) => msg(t)), photo, video]) {
        store.apartments.clear();
        await bot(msg('/start'));
        await enter();
        const before = out.length;
        await bot({ ...ev, dedupKey: `${ev.dedupKey}-${i}` });
        const label = `состояние ${i}, ${ev.type} «${(ev.text ?? ev.payload ?? '').slice(0, 30)}»`;
        assert.ok(out.length > before, `нет ответа: ${label}`);
        assert.doesNotMatch(out.at(-1)!.text, /Что-то пошло не так/, `исключение: ${label}`);
      }
    }
  });
});
