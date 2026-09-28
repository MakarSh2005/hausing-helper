import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createBot, type BotIO } from '../src/bot/bot.js';
import type { ParsedEvent } from '../src/webhook/parser.js';
import { HOUSES, memoryStore } from './memoryStore.js';

/** Чат дома в MAX: бот в групповом чате, привязка командой /дом, права администратора. */

const GROUP = '-7001';
let seq = 0;
const say = (userId: string, text: string, chatId = GROUP): ParsedEvent => ({
  type: 'message', dedupKey: `g${seq++}`, user: { userId }, userId, chatId, chatType: 'chat', text, attachments: [], timestamp: 1,
});

function setup(chat: { title: string | null; link: string | null; ownerId: string | null }, admins = ['900']) {
  const store = memoryStore();
  const sent: Array<{ chat: string; text: string; kb: number }> = [];
  const io: BotIO = {
    send: async (c, text, kb) => void sent.push({ chat: c, text, kb: kb?.length ?? 0 }),
    answer: async () => {},
    chatInfo: async () => chat,
    chatAdmins: async () => admins,
  };
  const bot = createBot({ store, io, logger: pino({ level: 'silent' }) });
  return { store, sent, bot };
}

describe('чат дома в MAX', () => {
  beforeEach(() => void (seq = 0));

  it('бота добавили в группу — приветствие с инструкцией; обычные сообщения — молчание', async () => {
    const { bot, sent, store } = setup({ title: 'Баумана 15', link: 'https://max.ru/join/abc', ownerId: '900' });
    await bot({ type: 'added', dedupKey: 'a', user: { userId: '900' }, userId: '900', chatId: GROUP, chatType: 'chat', timestamp: 1 });
    assert.match(sent[0]!.text, /\/дом Баумана 15/);
    assert.equal(sent[0]!.kb, 0, 'без кнопок в общем чате');
    for (const t of ['Всем привет!', 'Баумана 15', '/start', 'Течёт батарея', 'газ']) await bot(say('901', t));
    assert.equal(sent.length, 1, 'на сообщения соседей бот не отвечает');
    assert.equal(store.users.size, 0, 'и не заводит пользователей');
  });

  it('администратор привязывает чат к дому — ссылка берётся из данных чата', async () => {
    const { bot, sent, store } = setup({ title: 'Баумана 15 — соседи', link: 'https://max.ru/join/abc', ownerId: '900' });
    await bot(say('900', '/дом Бауманна 15'));
    assert.match(sent.at(-1)!.text, /^Готово: этот чат — чат дома ул\. Баумана, д\. 15/);
    const house = HOUSES.find((h) => h.street === 'ул. Баумана' && h.houseNumber === '15')!;
    assert.deepEqual(store.houseChats.map((c) => [c.houseId, c.chatId, c.title, c.link]), [[house.id, GROUP, 'Баумана 15 — соседи', 'https://max.ru/join/abc']]);

    // Жилец этого дома видит чат, жилец другого — нет
    store.apartments.set('501', { houseId: house.id, number: '5', entrance: null });
    store.apartments.set('502', { houseId: HOUSES.find((h) => h.id !== house.id)!.id, number: '5', entrance: null });
    assert.equal((await store.houseChat('501'))?.link, 'https://max.ru/join/abc');
    assert.equal(await store.houseChat('502'), null);

    await bot(say('900', '/дом'));
    assert.match(sent.at(-1)!.text, /привязан к дому ул\. Баумана, д\. 15/);
    // Бота убрали из чата — привязка снята
    await bot({ type: 'removed', dedupKey: 'r', user: { userId: '900' }, userId: '900', chatId: GROUP, chatType: 'chat', timestamp: 2 });
    assert.equal(store.houseChats.length, 0);
  });

  it('не администратор — отказ; чужая ссылка — отказ; ссылку можно передать командой', async () => {
    const { bot, sent, store } = setup({ title: 'Дом', link: null, ownerId: '900' }, ['900', '905']);
    await bot(say('901', '/дом Баумана 15'));
    assert.match(sent.at(-1)!.text, /только администратор/);
    assert.equal(store.houseChats.length, 0);

    await bot(say('905', '/дом Баумана 15 https://evil.example/join'));
    assert.match(sent.at(-1)!.text, /max\.ru/);
    assert.equal(store.houseChats.length, 0);

    await bot(say('905', '/дом Баумана 15'));
    assert.match(sent.at(-1)!.text, /ссылки-приглашения я не вижу/);
    assert.equal(store.houseChats[0]!.link, null);

    await bot(say('905', '/дом Баумана 15 https://max.ru/join/xyz'));
    assert.match(sent.at(-1)!.text, /^Готово/);
    assert.equal(store.houseChats[0]!.link, 'https://max.ru/join/xyz');
    assert.equal(store.houseChats.length, 1, 'у дома один чат');
  });

  it('адрес не найден или неполный — подсказка, привязки нет', async () => {
    const { bot, sent, store } = setup({ title: 'Дом', link: 'https://max.ru/join/a', ownerId: '900' });
    await bot(say('900', '/дом Ленина 5'));
    assert.match(sent.at(-1)!.text, /нет в справочнике[\s\S]*Пример/);
    await bot(say('900', '/дом Баумана'));
    assert.match(sent.at(-1)!.text, /номер дома/);
    assert.equal(store.houseChats.length, 0);
  });

  it('данные чата недоступны (бот не администратор) — понятная просьба', async () => {
    const store = memoryStore();
    const sent: string[] = [];
    const bot = createBot({
      store, logger: pino({ level: 'silent' }),
      io: { send: async (_c, t) => void sent.push(t), answer: async () => {}, chatInfo: async () => { throw new Error('403'); }, chatAdmins: async () => [] },
    });
    await bot(say('900', '/дом Баумана 15'));
    assert.match(sent[0]!, /Сделайте бота администратором/);
  });
});
