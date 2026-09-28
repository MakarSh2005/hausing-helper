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

function setup(chat: { title: string | null; link: string | null; ownerId: string | null }, admins = ['900'], opts: { staff?: string[] } = {}) {
  const store = memoryStore();
  const sent: Array<{ chat: string; text: string; kb: number; buttons: Button[] }> = [];
  const left: string[] = [];
  const io: BotIO = {
    send: async (c, text, kb) => void sent.push({ chat: c, text, kb: kb?.length ?? 0, buttons: (kb ?? []).flat() }),
    answer: async () => {},
    chatInfo: async () => chat,
    chatAdmins: async () => admins,
    leaveChat: async (c) => void left.push(c),
  };
  const bot = createBot({ store, io, logger: pino({ level: 'silent' }), options: { houseChatAdmins: opts.staff } });
  return { store, sent, bot, left };
}
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
    assert.match(sent.at(-1)!.text, /^Готово: это чат жильцов дома ул\. Баумана, д\. 15/);
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

describe('чат дома: бот приглашает жильцов сам', () => {
  it('чат привязан со ссылкой — бот рассылает приглашение всем жильцам дома, жильцам другого дома — нет', async () => {
    const { bot, store, sent } = setup({ title: 'Дом: Баумана 15', link: 'https://max.ru/join/b15', ownerId: '900' });
    store.apartments.set('501', { houseId: BAUMANA.id, number: '1', entrance: null });
    store.apartments.set('502', { houseId: BAUMANA.id, number: '2', entrance: null });
    store.apartments.set('503', { houseId: HOUSES.find((h) => h.id !== BAUMANA.id)!.id, number: '3', entrance: null });
    await bot(say('900', '/дом Баумана 15'));
    const invites = sent.filter((m) => m.chat.startsWith('dlg-'));
    assert.deepEqual(invites.map((m) => m.chat).sort(), ['dlg-501', 'dlg-502']);
    assert.match(invites[0]!.text, /^Для дома ул\. Баумана, д\. 15 создан чат жильцов в MAX — «Дом: Баумана 15»/);
    assert.deepEqual(invites[0]!.buttons, [{ type: 'link', text: 'Вступить в чат дома', url: 'https://max.ru/join/b15' }]);
    assert.match(sent.at(-1)!.text, /^Готово: это чат жильцов дома[\s\S]*отправил приглашение жильцам дома: 2/);

    // Повторная команда с той же ссылкой — второй рассылки нет
    await bot(say('900', '/дом Баумана 15'));
    assert.equal(sent.filter((m) => m.chat.startsWith('dlg-')).length, 2);
    assert.match(sent.at(-1)!.text, /уже было отправлено/);
  });

  it('новый жилец привязал адрес — приглашение сразу; чата нет — жильцу ничего не пишем', async () => {
    const { bot, store, sent } = setup({ title: null, link: null, ownerId: '900' });
    store.apartments.set('504', { houseId: BAUMANA.id, number: '4', entrance: null });
    assert.equal(await bot.offerHouseChat('504', 'dlg-504'), 'none');
    assert.equal(sent.length, 0, 'ни «создайте чат», ни кнопок');
    await store.bindHouseChat({ houseId: BAUMANA.id, chatId: '-9', title: null, link: 'https://max.ru/join/x', boundBy: '900' });
    assert.equal(await bot.offerHouseChat('504', 'dlg-504'), 'invited');
    assert.deepEqual(sent.at(-1)!.buttons, [{ type: 'link', text: 'Вступить в чат дома', url: 'https://max.ru/join/x' }]);
  });

  it('ссылки не было — бот просит её; после «/ссылка» рассылает приглашения', async () => {
    const { bot, store, sent } = setup({ title: 'Дом', link: null, ownerId: '900' });
    store.apartments.set('505', { houseId: BAUMANA.id, number: '5', entrance: null });
    await bot(say('900', '/дом Баумана 15'));
    assert.match(sent.at(-1)!.text, /ссылки-приглашения я не вижу[\s\S]*\/ссылка/);
    assert.equal(sent.filter((m) => m.chat.startsWith('dlg-')).length, 0);
    await bot(say('900', '/ссылка https://max.ru/join/late'));
    assert.deepEqual(sent.filter((m) => m.chat.startsWith('dlg-')).map((m) => m.chat), ['dlg-505']);
    assert.equal(store.houseChats[0]!.link, 'https://max.ru/join/late');
  });

  it('HOUSE_CHAT_ADMINS задан — привязать может только сотрудник сервиса', async () => {
    const { bot, store, sent } = setup({ title: 'Дом', link: 'https://max.ru/join/z', ownerId: '900' }, ['900', '901'], { staff: ['901'] });
    await bot(say('900', '/дом Баумана 15'));
    assert.match(sent.at(-1)!.text, /только сотрудники сервиса/);
    assert.equal(store.houseChats.length, 0);
    await bot(say('901', '/дом Баумана 15'));
    assert.equal(store.houseChats.length, 1);
  });
});
