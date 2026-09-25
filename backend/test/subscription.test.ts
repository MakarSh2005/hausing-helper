import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { MaxClient } from '../src/max/client.js';
import { autoSubscribe, ensureSubscription, UPDATE_TYPES } from '../src/max/subscription.js';
import { loadConfig } from '../src/config.js';

const log = pino({ level: 'silent' });
const URL_ = 'https://bot.example.amvera.io/webhook';

function fakeMax(opts: { postFails?: number; alreadyThere?: boolean; neverListed?: boolean }) {
  const subs: Array<{ url: string }> = opts.alreadyThere ? [{ url: URL_ }] : [];
  let postFails = opts.postFails ?? 0;
  const posts: unknown[] = [];
  const max = {
    subscribe: async (url: string, types: string[], secret: string) => {
      posts.push({ url, types, secret });
      if (postFails > 0) {
        postFails--;
        throw new Error('503');
      }
      if (!opts.neverListed && !subs.some((s) => s.url === url)) subs.push({ url });
      return { success: true };
    },
    listSubscriptions: async () => ({ subscriptions: subs }),
  };
  return { max: max as unknown as MaxClient, posts };
}

describe('ensureSubscription', () => {
  it('создаёт подписку с нужными типами и секретом', async () => {
    const { max, posts } = fakeMax({});
    assert.equal(await ensureSubscription(max, URL_, 'sec-123', log), 'created');
    assert.deepEqual(posts, [{ url: URL_, types: UPDATE_TYPES, secret: 'sec-123' }]);
  });

  it('POST отклонён, но подписка уже есть → existing', async () => {
    const { max } = fakeMax({ postFails: 1, alreadyThere: true });
    assert.equal(await ensureSubscription(max, URL_, 's', log), 'existing');
  });

  it('POST отклонён и подписки нет → ошибка', async () => {
    const { max } = fakeMax({ postFails: 1 });
    await assert.rejects(ensureSubscription(max, URL_, 's', log));
  });

  it('POST прошёл, но в списке подписки нет → ошибка', async () => {
    const { max } = fakeMax({ neverListed: true });
    await assert.rejects(ensureSubscription(max, URL_, 's', log), /не появилась/);
  });
});

describe('autoSubscribe', () => {
  it('повторяет, пока домен хостинга не заработает', async () => {
    const { max, posts } = fakeMax({ postFails: 2 });
    const sleeps: number[] = [];
    const ok = await autoSubscribe(max, 'https://bot.example.amvera.io/', 's', log, {
      attempts: 5,
      delayMs: 20_000,
      sleep: async (ms) => void sleeps.push(ms),
    });
    assert.equal(ok, true);
    assert.equal(posts.length, 3);
    assert.deepEqual(sleeps, [20_000, 20_000]);
    assert.equal((posts[0] as { url: string }).url, URL_, 'слэш в конце PUBLIC_BASE_URL не ломает адрес');
  });

  it('сдаётся после N попыток и возвращает false, не бросая', async () => {
    const { max } = fakeMax({ postFails: 99 });
    assert.equal(await autoSubscribe(max, 'https://x.io', 's', log, { attempts: 3, sleep: async () => {} }), false);
  });
});

describe('config: автоподписка', () => {
  const base = { MAX_BOT_TOKEN: 'token-0123456789', MAX_WEBHOOK_SECRET: 'abc-DEF-123', DATABASE_URL: 'file:/data/app.db' };
  it('MAX_AUTO_SUBSCRIBE=true без PUBLIC_BASE_URL → понятная ошибка', () => {
    assert.throws(() => loadConfig({ ...base, MAX_AUTO_SUBSCRIBE: 'true' }), /PUBLIC_BASE_URL: нужен при MAX_AUTO_SUBSCRIBE=true/);
  });
  it('PUBLIC_BASE_URL только https', () => {
    assert.throws(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'http://x.io' }), /https/);
    assert.equal(loadConfig({ ...base, MAX_AUTO_SUBSCRIBE: 'true', PUBLIC_BASE_URL: 'https://x.io' }).MAX_AUTO_SUBSCRIBE, true);
  });
});
