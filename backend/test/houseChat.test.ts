import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createBot, type BotIO } from '../src/bot/bot.js';
import type { ParsedEvent } from '../src/webhook/parser.js';
import type { Button } from '../src/max/keyboard.js';
import { HOUSES, memoryStore } from './memoryStore.js';

/** Чат дома в MAX: бот в групповом чате, привязка командой /дом, права администратора. */

const GROUP = '-7001';
let seq = 0;
const say = (userId: string, text: string, chatId = GROUP): ParsedEvent => ({
  type: 'message', dedupKey: `g${seq++}`, user: { userId }, userId, chatId, chatType: 'chat', text, attachments: [], timestamp: 1,
});

function setup(chat: { title: string | null; link: string | null; ownerId: string | null }, admins = ['900'], opts: { rejectChatButton?: boolean } = {}) {
  const store = memoryStore();
  const sent: Array<{ chat: string; text: string; kb: number; buttons: Button[] }> = [];
  const left: string[] = [];
  const io: BotIO = {
    send: async (c, text, kb) => {
      if (opts.rejectChatButton && kb?.flat().some((b) => b.type === 'chat')) throw new Error('MAX API 400: button type');
      sent.push({ chat: c, text, kb: kb?.length ?? 0, buttons: (kb ?? []).flat() });
    },
    answer: async () => {},
    chatInfo: async () => chat,
    chatAdmins: async () => admins,
    leaveChat: async (c) => void left.push(c),
  };
  const bot = createBot({ store, io, logger: pino({ level: 'silent' }), options: { groupGreetingDelayMs: 0 } });
  return { store, sent, bot, left };
}
const created = (chatId: string, payload: string, extra: Partial<ParsedEvent> = {}): ParsedEvent => ({
  type: 'chat_created', dedupKey: `cc${chatId}`, user: { userId: '501' }, userId: '501', chatId, chatType: 'chat', payload, timestamp: 1, ...extra,
});
const BAUMANA = HOUSES.find((h) => h.code === 'kzn_0018')!;

describe('чат дома в MAX', () => {
  beforeEach(() => void (seq = 0));

  it('бота добавили в группу вручную — приветствие с инструкцией; обычные сообщения — молчание', async () => {
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

describe('бот создаёт чат дома кнопкой MAX', () => {
  it('после привязки квартиры — кнопка «Создать чат дома» с названием и кодом дома', async () => {
    const { bot, store, sent } = setup({ title: null, link: null, ownerId: null });
    store.apartments.set('501', { houseId: BAUMANA.id, number: '5', entrance: null });
    assert.equal(await bot.offerHouseChat('501', 'dlg-501'), 'offered');
    const m = sent.at(-1)!;
    assert.equal(m.chat, 'dlg-501');
    assert.match(m.text, /пока нет чата жильцов в MAX[\s\S]*бот создаст чат дома/);
    assert.deepEqual(m.buttons[0], {
      type: 'chat', text: 'Создать чат дома', chat_title: 'Дом: ул. Баумана, д. 15',
      chat_description: 'Чат жильцов дома: отключения, собрания, новости. Создан ботом «Жилищный помощник».', start_payload: 'house:kzn_0018',
    });
    assert.equal(await bot.offerHouseChat('no-apartment', 'dlg'), 'no_apartment');
  });

  it('жилец нажал кнопку — MAX создал чат, бот привязал его к дому; ссылки нет — просит владельца', async () => {
    const { bot, store, sent } = setup({ title: 'Дом: ул. Баумана, д. 15', link: null, ownerId: '501' }, ['501']);
    await bot(created('-8001', 'house:kzn_0018'));
    assert.deepEqual(store.houseChats.map((c) => [c.houseId, c.chatId, c.title, c.link]), [[BAUMANA.id, '-8001', 'Дом: ул. Баумана, д. 15', null]]);
    assert.match(sent.at(-1)!.text, /^Это чат жильцов дома ул\. Баумана, д\. 15[\s\S]*\/ссылка https:\/\/max\.ru/);
    assert.equal(sent.at(-1)!.chat, '-8001');

    // Бот добавлен в этот же чат — второго приветствия с /дом нет
    const before = sent.length;
    await bot({ type: 'added', dedupKey: 'a1', user: { userId: '501' }, userId: '501', chatId: '-8001', chatType: 'chat', timestamp: 2 });
    assert.equal(sent.length, before);

    // Соседу пока — «ждём ссылку»
    store.apartments.set('502', { houseId: BAUMANA.id, number: '6', entrance: null });
    assert.equal(await bot.offerHouseChat('502', 'dlg-502'), 'pending');

    // Владелец присылает ссылку — теперь соседи получают приглашение
    await bot(say('777', '/ссылка https://max.ru/join/zzz', '-8001'));
    assert.match(sent.at(-1)!.text, /только администратор/);
    await bot(say('501', '/ссылка https://evil.example/x', '-8001'));
    assert.match(sent.at(-1)!.text, /max\.ru/);
    await bot(say('501', '/ссылка https://max.ru/join/zzz', '-8001'));
    assert.match(sent.at(-1)!.text, /^Спасибо/);
    assert.equal(store.houseChats[0]!.link, 'https://max.ru/join/zzz');
    assert.equal(await bot.offerHouseChat('502', 'dlg-502'), 'invited');
    assert.deepEqual(sent.at(-1)!.buttons, [{ type: 'link', text: 'Вступить в чат дома', url: 'https://max.ru/join/zzz' }]);
  });

  it('ссылка пришла вместе с созданием — жильцы сразу получают приглашение', async () => {
    const { bot, store, sent } = setup({ title: null, link: null, ownerId: '501' });
    await bot(created('-8002', 'house:kzn_0018', { chatLink: 'https://max.ru/join/abc', chatTitle: 'Дом: ул. Баумана, д. 15' }));
    assert.equal(store.houseChats[0]!.link, 'https://max.ru/join/abc');
    assert.match(sent.at(-1)!.text, /увидят приглашение в приложении/);
  });

  it('два жильца нажали кнопку одновременно — у дома остаётся первый чат, бот выходит из второго', async () => {
    const { bot, store, sent, left } = setup({ title: null, link: null, ownerId: '502' });
    await bot(created('-8003', 'house:kzn_0018', { chatLink: 'https://max.ru/join/first' }));
    await bot(created('-8004', 'house:kzn_0018'));
    assert.deepEqual(store.houseChats.map((c) => c.chatId), ['-8003']);
    assert.match(sent.at(-1)!.text, /уже есть чат жильцов: https:\/\/max\.ru\/join\/first/);
    assert.deepEqual(left, ['-8004']);
  });

  it('чат без кода дома — подсказка, привязки нет; MAX не принял кнопку — ручной способ', async () => {
    const { bot, store, sent } = setup({ title: null, link: null, ownerId: '1' });
    await bot(created('-8005', 'что-то'));
    assert.equal(store.houseChats.length, 0);
    assert.match(sent.at(-1)!.text, /Не понял, для какого дома/);

    const r = setup({ title: null, link: null, ownerId: null }, [], { rejectChatButton: true });
    r.store.apartments.set('501', { houseId: BAUMANA.id, number: '5', entrance: null });
    assert.equal(await r.bot.offerHouseChat('501', 'dlg'), 'manual');
    assert.match(r.sent.at(-1)!.text, /\/дом Баумана 15$/);
  });
});
