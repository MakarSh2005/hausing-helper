import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createBot, type BotIO } from '../src/bot/bot.js';
import type { BotStore } from '../src/bot/store.js';
import type { Button } from '../src/max/keyboard.js';
import type { ParsedEvent } from '../src/webhook/parser.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';

/**
 * Этап 9: «ломаем каждый шаг». Правило: на любое действие бот отвечает хотя бы одним сообщением,
 * не падает и оставляет путь дальше (кнопки или понятную подсказку).
 */

const U = '777';
let seq = 0;
const msg = (text: string): ParsedEvent => ({ type: 'message', dedupKey: `m${seq++}`, user: { userId: U }, userId: U, chatId: 'c', text, timestamp: 1 });
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
  const bot = createBot({ store, io, logger: log, options: { now: () => new Date(clock.now) } });
  const tapBtn = (label: string) => {
    const b = out.at(-1)!.buttons.find((x) => x.text === label);
    assert.ok(b?.payload, `нет кнопки «${label}»: ${out.at(-1)!.buttons.map((x) => x.text).join(' | ')}`);
    return bot(tap(b.payload!));
  };
  return { store, out, bot, tapBtn };
}

describe('устойчивость (этап 9)', () => {
  beforeEach(() => void (clock.now = Date.parse('2026-09-24T09:00:00Z')));

  it('основной сценарий три раза подряд одним пользователем', async () => {
    const { store, out, bot, tapBtn } = setup();
    await bot(msg('/start'));
    await bot(msg('Баумана 15'));
    await tapBtn('Да, это мой дом');
    await bot(msg('42'));
    await tapBtn('2');
    for (const problem of ['Течёт батарея', 'Не работает лифт', 'Не вывозят мусор третий день']) {
      await bot(msg(problem));
      await tapBtn('Отправить');
      assert.match(out.at(-1)!.text, /^Заявка REQ-2026-0000\d зарегистрирована/);
      await bot(msg('/start'));
      assert.match(out.at(-1)!.text, /С возвращением/);
    }
    assert.deepEqual(store.requests.map((r) => r.number), ['REQ-2026-00001', 'REQ-2026-00002', 'REQ-2026-00003']);
  });

  it('сбой базы при создании заявки: извинение, описание не потеряно, повтор «Отправить» создаёт заявку', async () => {
    const { store, out, bot, tapBtn } = setup();
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    await bot(msg('Течёт батарея'));
    const original = store.createRequest;
    store.createRequest = async () => {
      throw new Error('SQLITE_BUSY');
    };
    await tapBtn('Отправить');
    assert.match(out.at(-1)!.text, /Что-то пошло не так[\s\S]*данные сохранены/);
    store.createRequest = original;
    await bot(tap('req:send'));
    assert.match(out.at(-1)!.text, /^Заявка REQ-2026-00001 зарегистрирована/);
    assert.equal(store.requests.length, 1);
  });

  it('MAX не принял ответ — бот не падает, следующее сообщение обрабатывается', async () => {
    const { out, bot } = setup({ failSendOnce: true });
    await bot(msg('/start'));
    await bot(msg('Баумана 15'));
    assert.match(out.at(-1)!.text, /Нашёл дом/);
  });

  it('мусорные нажатия и сообщения в любом состоянии — всегда ответ', async () => {
    const { out, bot, tapBtn, store } = setup();
    const junkTaps = ['', 'x', 'req:cat:', 'req:cat:nope', 'onb:house:', 'onb:house:no-such', 'onb:street:Несуществующая',
      'onb:ent:', 'onb:ent:99', 'req:solved:', 'req:unsolved:r999', 'req:send', 'req:recat', 'req:cancel', 'menu:list', 'menu:apt', 'a'.repeat(900)];
    const junkMsgs = ['', '   ', '😀😀😀', '/unknown', '/help', "'; DROP TABLE users; --", 'а'.repeat(5000), '0', 'кв 0', '12345', 'нет', 'да'];
    const states: Array<() => Promise<void>> = [
      async () => {},
      async () => void (await bot(msg('Баумана 15'))),
      async () => {
        await bot(msg('Баумана 15'));
        await tapBtn('Да, это мой дом');
      },
      async () => {
        store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
        await bot(msg('Течёт батарея'));
      },
      async () => {
        store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
        await bot(tap('menu:request'));
      },
    ];
    for (const [i, enter] of states.entries()) {
      for (const ev of [...junkTaps.map(tap), ...junkMsgs.map(msg)]) {
        await bot(msg('/start'));
        store.apartments.clear();
        await enter();
        const before = out.length;
        await bot(ev);
        assert.ok(out.length > before, `нет ответа: состояние ${i}, событие ${ev.type} «${(ev.text ?? ev.payload ?? '').slice(0, 30)}»`);
        assert.doesNotMatch(out.at(-1)!.text, /Что-то пошло не так/, `исключение: состояние ${i}, «${(ev.text ?? ev.payload ?? '').slice(0, 30)}»`);
      }
    }
  });

  it('неизвестная команда и /help — подсказка с кнопками', async () => {
    const { out, bot, store } = setup();
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    await bot(msg('/help'));
    assert.match(out.at(-1)!.text, /опишите проблему одним сообщением/);
    assert.ok(out.at(-1)!.buttons.some((b) => b.text === 'Мои заявки'));
    await bot(msg('/unknown'));
    assert.ok(out.at(-1)!.buttons.length > 0, 'после неизвестной команды есть кнопки');
  });

  it('«Да, решена» по уже закрытой заявке — не дублируем, «Нет» по закрытой — без жалобы', async () => {
    const { out, bot, tapBtn, store } = setup();
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    await bot(msg('Не работает лифт'));
    await tapBtn('Отправить');
    await bot(tap('req:solved:r1'));
    await bot(tap('req:solved:r1'));
    assert.match(out.at(-1)!.text, /уже закрыта/);
    await bot(tap('req:unsolved:r1'));
    assert.match(out.at(-1)!.text, /уже закрыта/);
  });
});

void (null as unknown as BotStore);
