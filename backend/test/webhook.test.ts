import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { createWebhookHandler, secretMatches } from '../src/webhook/handler.js';
import type { ParsedEvent } from '../src/webhook/parser.js';
import { SlidingWindowLimiter } from '../src/webhook/rateLimit.js';
import { botStarted, clone, messageCallback, messageCreated } from './fixtures.js';

const SECRET = 'test-secret-abcdef123456';
const logger = pino({ level: 'silent' });

/** Минимальная заглушка Prisma: processed_updates с уникальностью и upsert пользователя. */
function fakeDb() {
  const processed = new Set<string>();
  const users = new Map<string, unknown>();
  const db = {
    processedUpdate: {
      create: async ({ data }: { data: { id: string } }) => {
        if (processed.has(data.id)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        processed.add(data.id);
        return data;
      },
    },
    user: {
      upsert: async ({ where, create }: { where: { maxUserId: string }; create: unknown }) => {
        users.set(where.maxUserId, create);
        return create;
      },
    },
    $queryRaw: async () => [{ 1: 1 }],
  };
  return { db: db as unknown as Db, processed, users };
}

describe('POST /webhook', () => {
  let server: Server;
  let base: string;
  let routed: ParsedEvent[];
  let state: ReturnType<typeof fakeDb>;
  let wh: ReturnType<typeof createWebhookHandler>;
  let limiter: SlidingWindowLimiter;

  before(async () => {
    state = fakeDb();
    routed = [];
    limiter = new SlidingWindowLimiter(100);
    wh = createWebhookHandler({
      secret: SECRET,
      db: state.db,
      logger,
      limiter,
      route: async (ev) => void routed.push(ev),
    });
    server = createApp({ db: state.db, logger, webhook: wh }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    routed.length = 0;
    state.processed.clear();
  });

  const post = (body: unknown, secret?: string, raw = false) =>
    fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-max-bot-api-secret': secret } : {}) },
      body: raw ? (body as string) : JSON.stringify(body),
    });

  /** Обработка асинхронная — ждём, пока все события дойдут до роутера. */
  const settle = () => wh.drain(1000);

  it('групповой чат: событие доходит до бота, но пользователь и его диалог не трогаются', async () => {
    state.users.clear();
    const group = clone(messageCreated);
    group.message.recipient = { chat_id: -555, chat_type: 'chat' };
    group.message.body.mid = 'mid.group1';
    assert.equal((await post(group, SECRET)).status, 200);
    const added = { update_type: 'bot_added', timestamp: 1758654000001, chat_id: -555, user: { user_id: 42, name: 'Админ' }, is_channel: false };
    assert.equal((await post(added, SECRET)).status, 200);
    await settle();
    assert.deepEqual(routed.map((e) => [e.type, e.chatId, e.chatType]), [['message', '-555', 'chat'], ['added', '-555', 'chat']]);
    assert.equal(state.users.size, 0, 'chat_id группы не записан как диалог с ботом');
    // Канал — не наш случай
    await post({ ...added, timestamp: 2, is_channel: true }, SECRET);
    await settle();
    assert.equal(routed.length, 2);
  });

  it('GET /bot без данных о боте → 503', async () => {
    assert.equal((await fetch(`${base}/bot`)).status, 503);
  });

  it('GET /health → {"status":"ok"}', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('GET /webhook → 200 (проверка доступности), без обработки', async () => {
    const res = await fetch(`${base}/webhook`);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(routed.length, 0);
  });

  it('без секрета → 401, событие не обрабатывается', async () => {
    const res = await post(messageCreated);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    await settle();
    assert.equal(routed.length, 0);
  });

  it('неверный секрет (в т.ч. другой длины) → 401', async () => {
    for (const s of ['wrong', SECRET + 'x', SECRET.slice(0, -1)]) {
      assert.equal((await post(messageCreated, s)).status, 401);
    }
    await settle();
    assert.equal(routed.length, 0);
  });

  it('битый JSON без секрета → 401 (секрет проверяется до разбора тела)', async () => {
    assert.equal((await post('{not json', undefined, true)).status, 401);
  });

  it('битый JSON с верным секретом → 200, чтобы MAX не ретраил', async () => {
    const res = await post('{not json', SECRET, true);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('верный секрет → 200 {"ok":true}, событие доходит до роутера', async () => {
    const res = await post(messageCreated, SECRET);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    await settle();
    assert.equal(routed.length, 1);
    assert.equal(routed[0]!.text, 'Течёт батарея');
    assert.ok(state.users.has('1234567890'));
  });

  it('200 отдаётся до окончания обработки', async () => {
    let release!: () => void;
    const slow = createWebhookHandler({
      secret: SECRET,
      db: state.db,
      logger,
      limiter: new SlidingWindowLimiter(100),
      route: () => new Promise<void>((r) => (release = r)),
    });
    const s = createApp({ db: state.db, logger, webhook: slow }).listen(0);
    await new Promise((r) => s.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': SECRET },
      body: JSON.stringify({ ...clone(messageCreated), message: { ...messageCreated.message, body: { ...messageCreated.message.body, mid: 'mid.slow' } } }),
    });
    assert.equal(res.status, 200, 'ответ пришёл, хотя роутер ещё не завершился');
    // дождаться, пока обработчик дойдёт до роутера, затем отпустить
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    release();
    await slow.drain(1000);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('повторная доставка того же message_created обрабатывается один раз', async () => {
    await Promise.all([post(messageCreated, SECRET), post(messageCreated, SECRET), post(messageCreated, SECRET)]);
    await settle();
    assert.equal(routed.length, 1);
  });

  it('повторный callback и bot_started — тоже один раз', async () => {
    await post(messageCallback, SECRET);
    await post(messageCallback, SECRET);
    await post(botStarted, SECRET);
    await post(botStarted, SECRET);
    await settle();
    assert.deepEqual(routed.map((e) => e.type), ['callback', 'started']);
  });

  it('разные сообщения — разные события', async () => {
    const second = clone(messageCreated);
    second.message.body.mid = 'mid.other';
    await post(messageCreated, SECRET);
    await post(second, SECRET);
    await settle();
    assert.equal(routed.length, 2);
  });

  it('ненужный тип события → 200 и тишина', async () => {
    const res = await post({ update_type: 'message_edited', timestamp: 1 }, SECRET);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(routed.length, 0);
  });

  it('ошибка в роутере не роняет сервер и не меняет ответ', async () => {
    const failing = createWebhookHandler({
      secret: SECRET,
      db: fakeDb().db,
      logger,
      limiter: new SlidingWindowLimiter(100),
      route: async () => {
        throw new Error('boom');
      },
    });
    const s = createApp({ db: state.db, logger, webhook: failing }).listen(0);
    await new Promise((r) => s.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': SECRET },
      body: JSON.stringify(messageCreated),
    });
    assert.equal(res.status, 200);
    await failing.drain(1000);
    await new Promise<void>((r) => s.close(() => r()));
  });
});

describe('GET /bot', () => {
  it('отдаёт имя и ссылку, без токена и секретов', async () => {
    const { db } = fakeDb();
    const wh = createWebhookHandler({ secret: SECRET, db, logger, limiter: new SlidingWindowLimiter(100), route: async () => {} });
    const s = createApp({ db, logger, webhook: wh, botInfo: { name: 'Жилищный помощник', username: 'zhkh_bot', link: 'https://max.ru/zhkh_bot' } }).listen(0);
    await new Promise((r) => s.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/bot`);
    assert.deepEqual(await res.json(), { name: 'Жилищный помощник', username: 'zhkh_bot', link: 'https://max.ru/zhkh_bot' });
    await new Promise<void>((r) => s.close(() => r()));
  });
});

describe('secretMatches', () => {
  it('сравнивает корректно', () => {
    assert.equal(secretMatches(SECRET, SECRET), true);
    assert.equal(secretMatches(undefined, SECRET), false);
    assert.equal(secretMatches('', SECRET), false);
    assert.equal(secretMatches('short', SECRET), false);
  });
});

describe('SlidingWindowLimiter', () => {
  it('100 в минуту на user_id, окно сдвигается', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(100, 60_000, () => t);
    for (let i = 0; i < 100; i++) assert.equal(l.allow('u1'), true);
    assert.equal(l.allow('u1'), false);
    assert.equal(l.allow('u2'), true, 'лимит у каждого пользователя свой');
    t = 60_001;
    assert.equal(l.allow('u1'), true);
    l.sweep();
  });
});
