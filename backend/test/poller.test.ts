import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { MaxApiError, MaxClient } from '../src/max/client.js';
import { startPoller } from '../src/max/poller.js';
import { messageCreated } from './fixtures.js';

const log = pino({ level: 'silent' });

type Resp = { updates: unknown[]; marker: number | null } | Error;

function fakeMax(responses: Resp[]) {
  const calls: Array<{ marker?: number | null; types?: string[] }> = [];
  const max = {
    getUpdates: async (params: { marker?: number | null; types?: string[] }, signal?: AbortSignal) => {
      calls.push({ marker: params.marker, types: params.types });
      const next = responses.shift();
      if (!next) {
        // Очередь пуста — «висим» как настоящий long polling, пока нас не остановят.
        await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (next instanceof Error) throw next;
      return next!;
    },
  };
  return { max: max as unknown as MaxClient, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('long polling', () => {
  it('обрабатывает события, передаёт marker дальше и фильтрует типы', async () => {
    const got: unknown[] = [];
    const { max, calls } = fakeMax([
      { updates: [messageCreated], marker: 101 },
      { updates: [], marker: 101 },
      { updates: [{ update_type: 'bot_started' }], marker: 102 },
    ]);
    const p = startPoller({ max, logger: log, processUpdate: async (u) => void got.push(u), sleep: async () => {} });
    for (let i = 0; i < 20 && calls.length < 4; i++) await tick();
    await p.stop();
    assert.equal(got.length, 2);
    assert.deepEqual(calls.slice(0, 4).map((c) => c.marker), [null, 101, 101, 102]);
    assert.deepEqual(calls[0]!.types, ['message_created', 'bot_started', 'message_callback', 'bot_added', 'bot_removed']);
  });

  it('ошибка сети → пауза и повтор; ошибка обработки одного события не останавливает опрос', async () => {
    const sleeps: number[] = [];
    const got: unknown[] = [];
    const { max, calls } = fakeMax([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      { updates: [{ n: 1 }, { n: 2 }], marker: 5 },
    ]);
    const p = startPoller({
      max,
      logger: log,
      processUpdate: async (u) => {
        if ((u as { n: number }).n === 1) throw new Error('boom');
        got.push(u);
      },
      sleep: async (ms) => void sleeps.push(ms),
    });
    for (let i = 0; i < 20 && calls.length < 4; i++) await tick();
    await p.stop();
    assert.deepEqual(sleeps.slice(0, 2), [1000, 2000]);
    assert.deepEqual(got, [{ n: 2 }]);
  });

  it('401 — останавливается, не долбит API', async () => {
    const { max, calls } = fakeMax([new MaxApiError(401, 'GET', '/updates', '')]);
    const p = startPoller({ max, logger: log, processUpdate: async () => {}, sleep: async () => {} });
    await p.done;
    assert.equal(calls.length, 1);
  });

  it('getUpdates: параметры запроса и увеличенный таймаут', async () => {
    let seen: URL | undefined;
    const impl = (async (url: URL) => {
      seen = url;
      return new Response(JSON.stringify({ updates: [], marker: 7 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new MaxClient({ token: 'test-token-0123456789', baseUrl: 'https://x', logger: log, fetchImpl: impl });
    const r = await client.getUpdates({ marker: 6, timeoutSec: 30, types: ['message_created', 'bot_started'] });
    assert.deepEqual(r, { updates: [], marker: 7 });
    assert.equal(seen!.pathname, '/updates');
    assert.equal(seen!.searchParams.get('marker'), '6');
    assert.equal(seen!.searchParams.get('timeout'), '30');
    assert.equal(seen!.searchParams.get('types'), 'message_created,bot_started');
  });
});

describe('config: режимы', () => {
  const base = { MAX_BOT_TOKEN: 'token-0123456789', DATABASE_URL: 'file:./dev.db' };
  it('polling работает без секрета вебхука', () => {
    const c = loadConfig({ ...base, MAX_MODE: 'polling' });
    assert.equal(c.MAX_MODE, 'polling');
    assert.equal(c.MAX_WEBHOOK_SECRET, undefined);
  });
  it('webhook без секрета — понятная ошибка с подсказкой про polling', () => {
    assert.throws(() => loadConfig(base), /MAX_WEBHOOK_SECRET: нужен в режиме MAX_MODE=webhook.*polling/);
  });
});
