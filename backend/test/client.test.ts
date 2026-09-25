import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { MaxApiError, MaxClient } from '../src/max/client.js';
import { btn, inlineKeyboard } from '../src/max/keyboard.js';

const TOKEN = 'test-token-0123456789';
const logger = pino({ level: 'silent' });

type Call = { url: URL; init: RequestInit };

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch: ответы закончились');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeClient(responses: Array<Response | Error>) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const client = new MaxClient({
    token: TOKEN,
    baseUrl: 'https://platform-api2.max.ru/',
    logger,
    fetchImpl: f.impl,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, calls: f.calls, sleeps };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('MaxClient.sendMessage', () => {
  it('шлёт POST /messages?chat_id, токен без Bearer, тело JSON', async () => {
    const { client, calls } = makeClient([json(200, { message: { body: { mid: 'm1' } } })]);
    const res = await client.sendMessage({ chatId: '42' }, { text: 'Привет', format: 'markdown' });
    assert.deepEqual(res, { message: { body: { mid: 'm1' } } });
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.url.toString(), 'https://platform-api2.max.ru/messages?chat_id=42');
    assert.equal(c.init.method, 'POST');
    const h = c.init.headers as Record<string, string>;
    assert.equal(h.Authorization, TOKEN);
    assert.ok(!h.Authorization.startsWith('Bearer'));
    assert.deepEqual(JSON.parse(c.init.body as string), { text: 'Привет', format: 'markdown' });
    assert.ok(c.init.signal, 'должен быть таймаут');
  });

  it('адресат user_id', async () => {
    const { client, calls } = makeClient([json(200, {})]);
    await client.sendMessage({ userId: '7' }, { text: 'x' });
    assert.equal(calls[0]!.url.search, '?user_id=7');
  });

  it('429 → ждёт Retry-After и повторяет', async () => {
    const { client, calls, sleeps } = makeClient([json(429, {}, { 'retry-after': '2' }), json(200, { ok: 1 })]);
    assert.deepEqual(await client.sendMessage({ chatId: '1' }, { text: 'x' }), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(sleeps[0], 2000);
  });

  it('5xx и сетевая ошибка → повтор с backoff 1s, 2s', async () => {
    const { client, calls, sleeps } = makeClient([json(502, {}), new TypeError('fetch failed'), json(200, {})]);
    await client.sendMessage({ chatId: '1' }, { text: 'x' });
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps.slice(0, 2), [1000, 2000]);
  });

  it('400 → без повторов, MaxApiError', async () => {
    const { client, calls } = makeClient([json(400, { code: 'bad' })]);
    await assert.rejects(client.sendMessage({ chatId: '1' }, { text: 'x' }), (e: unknown) => e instanceof MaxApiError && e.status === 400);
    assert.equal(calls.length, 1);
  });

  it('все попытки исчерпаны на 429 → ошибка, а не молчаливый undefined', async () => {
    const { client, calls } = makeClient([json(429, {}), json(429, {}), json(429, {})]);
    await assert.rejects(client.sendMessage({ chatId: '1' }, { text: 'x' }), (e: unknown) => e instanceof MaxApiError && e.status === 429);
    assert.equal(calls.length, 3);
  });

  it('токен вырезается из текста ошибки', async () => {
    const { client } = makeClient([json(401, { message: `invalid token ${TOKEN}` })]);
    await assert.rejects(client.getMe(), (e: unknown) => e instanceof Error && !e.message.includes(TOKEN) && e.message.includes('***'));
  });

  it('текст длиннее 4000 символов отклоняется до отправки', async () => {
    const { client, calls } = makeClient([]);
    assert.throws(() => client.sendMessage({ chatId: '1' }, { text: 'a'.repeat(4001) }), RangeError);
    assert.equal(calls.length, 0);
  });

  it('сообщения в один чат уходят по очереди с паузой (лимит 2 msg/s)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const impl = (async (url: URL, init: RequestInit) => {
      const text = JSON.parse(init.body as string).text as string;
      order.push(`start:${text}`);
      if (text === 'first') await gate;
      order.push(`end:${text}`);
      return json(200, {});
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const client = new MaxClient({ token: TOKEN, baseUrl: 'https://x', logger, fetchImpl: impl, sleep: async (ms) => void sleeps.push(ms) });

    const p1 = client.sendMessage({ chatId: '1' }, { text: 'first' });
    const p2 = client.sendMessage({ chatId: '1' }, { text: 'second' });
    const p3 = client.sendMessage({ chatId: '2' }, { text: 'other-chat' });
    await p3; // другой чат не ждёт
    assert.ok(!order.includes('start:second'), 'второе сообщение в тот же чат не должно стартовать раньше первого');
    release();
    await Promise.all([p1, p2]);
    assert.ok(order.indexOf('end:first') < order.indexOf('start:second'));
    assert.ok(sleeps.includes(550));
  });
});

describe('MaxClient.answerCallback', () => {
  it('200 с success=false — это отказ, а не успех', async () => {
    const { client } = makeClient([json(200, { success: false, message: 'callback expired' })]);
    await assert.rejects(client.answerCallback('cb.1', { notification: 'x' }), /success=false — callback expired/);
  });

  it('POST /answers?callback_id', async () => {
    const { client, calls } = makeClient([json(200, { success: true })]);
    await client.answerCallback('cb.1', { notification: 'ok' });
    assert.equal(calls[0]!.url.pathname, '/answers');
    assert.equal(calls[0]!.url.searchParams.get('callback_id'), 'cb.1');
  });
});

describe('inlineKeyboard', () => {
  it('собирает вложение по формату ТЗ 5.0.3', () => {
    const kb = inlineKeyboard([
      [btn.callback('Оформить заявку', 'req:new:heating'), btn.callback('Другая проблема', 'req:category')],
      [btn.link('Мои заявки', 'https://app.example.com/requests')],
      [],
    ]);
    assert.deepEqual(kb, {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Оформить заявку', payload: 'req:new:heating' },
            { type: 'callback', text: 'Другая проблема', payload: 'req:category' },
          ],
          [{ type: 'link', text: 'Мои заявки', url: 'https://app.example.com/requests' }],
        ],
      },
    });
  });

  it('link-кнопка требует https', () => {
    assert.throws(() => btn.link('x', 'http://insecure'));
  });
});
