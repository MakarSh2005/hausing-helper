import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { createApiRouter } from '../src/api/router.js';
import { createApp } from '../src/app.js';
import { issueSessionToken, linkSecret } from '../src/auth/sessionToken.js';
import { signWebAppData } from '../src/auth/webAppData.js';
import type { Db } from '../src/db.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';

const TOKEN = 'test-bot-token-1234567890';
const SECRET = 's'.repeat(40);
const ME = '67890';
const OTHER = '55555';
const logger = pino({ level: 'silent' });
const noop = () => {};
const webhook = { verify: noop, handler: noop, onBodyError: noop } as never;
const db = { $queryRaw: async () => [] } as unknown as Db;

function webAppData(userId: string, authDate = Math.floor(clock.now / 1000)): string {
  const p: Array<[string, string]> = [
    ['auth_date', String(authDate)],
    ['query_id', 'q-1'],
    ['user', JSON.stringify({ id: Number(userId), first_name: 'Анна' })],
  ];
  return [...p, ['hash', signWebAppData(p, TOKEN)] as [string, string]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

describe('API мини-приложения', () => {
  let server: Server;
  let base: string;
  let store: ReturnType<typeof memoryStore>;
  let webappDir: string;

  const call = (p: string, init: RequestInit & { token?: string } = {}) =>
    fetch(base + p, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    });
  const tokenFor = (u: string) => issueSessionToken(u, SECRET, 3600, clock.now);

  before(async () => {
    clock.now = Date.parse('2026-09-24T09:00:00Z');
    store = memoryStore();
    webappDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-'));
    fs.mkdirSync(path.join(webappDir, 'assets'));
    fs.writeFileSync(path.join(webappDir, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(webappDir, 'assets', 'main-abc.js'), 'console.log(1)');
    const api = createApiRouter({
      store, logger, botToken: TOKEN, sessionSecret: SECRET, sessionTtlSec: 3600,
      demoStatuses: true, now: () => new Date(clock.now), perUserPerMin: 40,
    });
    server = createApp({ db, logger, webhook, api, webappDir }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    fs.rmSync(webappDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    store.apartments.clear();
    store.requests.length = 0;
  });

  it('вход: подписанные данные → токен; подделка → 401; без тела → 400', async () => {
    const ok = await call('/api/auth/session', { method: 'POST', body: JSON.stringify({ web_app_data: webAppData(ME) }) });
    assert.equal(ok.status, 200);
    const j = (await ok.json()) as { token: string; expires_in: number; user: { first_name: string } };
    assert.equal(j.expires_in, 3600);
    assert.equal(j.user.first_name, 'Анна');
    assert.ok(store.users.has(ME), 'пользователь создан');
    const me = await call('/api/me', { token: j.token });
    assert.equal(me.status, 200);

    const forged = webAppData(ME).replace('67890', '55555');
    const bad = await call('/api/auth/session', { method: 'POST', body: JSON.stringify({ web_app_data: forged }) });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: 'invalid_web_app_data', reason: 'bad_hash' });

    const old = await call('/api/auth/session', { method: 'POST', body: JSON.stringify({ web_app_data: webAppData(ME, 1) }) });
    assert.equal(old.status, 401);
    assert.equal((await call('/api/auth/session', { method: 'POST', body: '{}' })).status, 400);
  });

  it('вход по ссылке из бота: код → сессия; сессионный токен вместо кода и наоборот не проходят', async () => {
    const code = issueSessionToken(ME, linkSecret(SECRET), 86_400, clock.now);
    const ok = await call('/api/auth/link', { method: 'POST', body: JSON.stringify({ code }) });
    assert.equal(ok.status, 200);
    const { token } = (await ok.json()) as { token: string };
    assert.equal((await call('/api/me', { token })).status, 200);
    assert.equal((await call('/api/me', { token: code })).status, 401, 'код ссылки — не сессия');
    const swapped = await call('/api/auth/link', { method: 'POST', body: JSON.stringify({ code: token }) });
    assert.equal(swapped.status, 401, 'сессия — не код ссылки');
    const old = issueSessionToken(ME, linkSecret(SECRET), 60, clock.now - 120_000);
    assert.equal((await call('/api/auth/link', { method: 'POST', body: JSON.stringify({ code: old }) })).status, 401);
  });

  it('без токена и с испорченным токеном → 401 (чек-лист ТЗ 9.4)', async () => {
    assert.equal((await call('/api/me')).status, 401);
    assert.equal((await call('/api/me', { token: 'abc.def.ghi' })).status, 401);
    assert.equal((await call('/api/requests', { token: issueSessionToken(ME, 'другой-ключ'.padEnd(40, 'x'), 3600, clock.now) })).status, 401);
    const expired = issueSessionToken(ME, SECRET, 60, clock.now - 120_000);
    assert.deepEqual(await (await call('/api/me', { token: expired })).json(), { error: 'token_invalid_or_expired' });
  });

  it('/api/me: квартира, УК без телефонов, пока данные не проверены', async () => {
    assert.deepEqual(await (await call('/api/me', { token: tokenFor(ME) })).json(), { apartment: null });
    store.apartments.set(ME, { houseId: HOUSES.find((h) => h.code === 'kzn_0018')!.id, number: '42', entrance: 2 });
    const res = await call('/api/me', { token: tokenFor(ME) });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { apartment: a } = (await res.json()) as { apartment: Record<string, any> };
    assert.equal(a.address, 'ул. Баумана, д. 15');
    assert.equal(a.number, '42');
    assert.equal(a.uk.verified, false);
    assert.equal(a.uk.phone, null);
    assert.equal(a.uk.dispatcher_phone, null);
  });

  it('заявки: только свои; чужой id → 404 (чек-лист ТЗ 9.4); демо-статус и просрочка', async () => {
    const house = HOUSES.find((h) => h.code === 'kzn_0018')!.id;
    store.apartments.set(ME, { houseId: house, number: '42', entrance: 2 });
    store.apartments.set(OTHER, { houseId: house, number: '7', entrance: 1 });
    const mine = await store.createRequest(ME, { address: 'ул. Баумана, д. 15, кв. 42, подъезд 2', category: 'heating', description: 'Течёт батарея', orgType: 'UK', dueAt: new Date(clock.now + 2 * 3_600_000) });
    const theirs = await store.createRequest(OTHER, { address: 'ул. Баумана, д. 15, кв. 7', category: 'elevator', description: 'Лифт', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });

    const list = (await (await call('/api/requests', { token: tokenFor(ME) })).json()) as { items: Array<Record<string, any>> };
    assert.deepEqual(list.items.map((r) => r.number), [mine.number]);
    assert.equal(list.items[0]!.status_label, 'зарегистрирована');
    assert.equal(list.items[0]!.norm.ref, 'п. 108 Правил № 354, п. 13 Правил № 416');

    assert.equal((await call(`/api/requests/${theirs.id}`, { token: tokenFor(ME) })).status, 404);
    assert.equal((await call(`/api/requests/..%2F..%2Fetc`, { token: tokenFor(ME) })).status, 404);
    const own = await call(`/api/requests/${mine.id}`, { token: tokenFor(ME) });
    assert.equal(own.status, 200);

    clock.now += 3 * 3_600_000;
    const r = (await (await call(`/api/requests/${mine.id}`, { token: tokenFor(ME) })).json()) as Record<string, any>;
    assert.equal(r.status, 'in_progress');
    assert.equal(r.status_is_demo, true);
    assert.equal(r.overdue, true);
    clock.now -= 3 * 3_600_000;
  });

  it('отзыв заявки: своя открытая → отозвана; повтор → 409; чужая → 404; без токена → 401', async () => {
    const house = HOUSES.find((h) => h.code === 'kzn_0018')!.id;
    store.apartments.set(ME, { houseId: house, number: '42', entrance: 2 });
    store.apartments.set(OTHER, { houseId: house, number: '7', entrance: 1 });
    const mine = await store.createRequest(ME, { address: 'a', category: 'elevator', description: 'Лифт', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    const theirs = await store.createRequest(OTHER, { address: 'b', category: 'roof', description: 'Крыша', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    assert.equal((await call(`/api/requests/${mine.id}/cancel`, { method: 'POST' })).status, 401);
    assert.equal((await call(`/api/requests/${theirs.id}/cancel`, { method: 'POST', token: tokenFor(ME) })).status, 404);
    assert.equal(store.requests.find((r) => r.id === theirs.id)!.status, 'created', 'чужая не тронута');
    const ok = await call(`/api/requests/${mine.id}/cancel`, { method: 'POST', token: tokenFor(ME) });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, any>;
    assert.equal(body.status, 'cancelled');
    assert.equal(body.status_label, 'отозвана');
    assert.equal(body.can_cancel, false);
    assert.equal(body.overdue, false);
    const again = await call(`/api/requests/${mine.id}/cancel`, { method: 'POST', token: tokenFor(ME) });
    assert.equal(again.status, 409);
  });

  it('подача заявки из мини-приложения: категория, превью, создание, дубль, газ, без квартиры', async () => {
    const t = tokenFor(ME);
    const json = (p: string, body: unknown, token = t) => call(p, { method: 'POST', token, body: JSON.stringify(body) });
    assert.equal((await json('/api/requests', { description: 'Течёт батарея', category: 'heating' })).status, 409, 'без квартиры');
    store.apartments.set(ME, { houseId: HOUSES.find((h) => h.code === 'kzn_0018')!.id, number: '42', entrance: 2 });

    const cat = (await (await call('/api/catalog', { token: t })).json()) as { categories: Array<{ id: string; title: string }>; max_photos: number };
    assert.equal(cat.max_photos, 5);
    assert.ok(cat.categories.some((c) => c.id === 'heating' && c.title === 'Отопление'));
    assert.ok(!cat.categories.some((c) => c.id === 'gas'), 'газа среди категорий нет');

    assert.deepEqual(await (await json('/api/requests/suggest', { description: 'Течёт батарея в комнате' })).json(), { category: 'heating', gas: false });
    assert.deepEqual(await (await json('/api/requests/suggest', { description: 'Пахнет газом' })).json(), { category: null, gas: true });

    const created = await json('/api/requests', { description: '  Течёт   батарея в комнате ', category: 'heating' });
    assert.equal(created.status, 201);
    const r = (await created.json()) as Record<string, any>;
    assert.match(r.number, /^REQ-2026-\d{5}$/);
    assert.equal(r.description, 'Течёт батарея в комнате');
    assert.equal(r.address, 'ул. Баумана, д. 15, кв. 42, подъезд 2');
    assert.equal(r.norm.ref, 'п. 108 Правил № 354, п. 13 Правил № 416');
    assert.equal(new Date(r.due_at).getTime() - clock.now, 2 * 3_600_000);

    const again = await json('/api/requests', { description: 'Течёт батарея в комнате', category: 'heating' });
    assert.equal(again.status, 200, 'повторная отправка того же — та же заявка');
    assert.equal(((await again.json()) as { id: string }).id, r.id);
    assert.equal(store.requests.filter((x) => x.user === ME).length, 1);

    assert.deepEqual(await (await json('/api/requests', { description: 'Пахнет газом в подъезде', category: 'other' })).json(), { error: 'gas' });
    assert.deepEqual(await (await json('/api/requests', { description: 'ой', category: 'other' })).json(), { error: 'too_short' });
    assert.deepEqual(await (await json('/api/requests', { description: 'Сломана лавочка во дворе', category: 'nope' })).json(), { error: 'bad_category' });
  });

  it('«Проблема решена» и текст жалобы в ГЖИ — только по своей заявке', async () => {
    store.apartments.set(ME, { houseId: HOUSES.find((h) => h.code === 'kzn_0018')!.id, number: '42', entrance: 2 });
    store.apartments.set(OTHER, { houseId: HOUSES[0]!.id, number: '7', entrance: null });
    const mine = await store.createRequest(ME, { address: 'ул. Баумана, д. 15, кв. 42, подъезд 2', category: 'water', description: 'Прорвало трубу', orgType: 'UK', dueAt: new Date(clock.now - 1000) });
    const view = (await (await call(`/api/requests/${mine.id}`, { token: tokenFor(ME) })).json()) as Record<string, any>;
    assert.equal(view.can_complain, true);
    const c = (await (await call(`/api/requests/${mine.id}/complaint`, { token: tokenFor(ME) })).json()) as { text: string; where: string };
    assert.match(c.text, /^В Государственную жилищную инспекцию Республики Татарстан[\s\S]*Адрес: Казань, ул\. Баумана, д\. 15, кв\. 42, подъезд 2[\s\S]*«Прорвало трубу»/);
    assert.equal((await call(`/api/requests/${mine.id}/complaint`, { token: tokenFor(OTHER) })).status, 404);
    assert.equal((await call(`/api/requests/${mine.id}/resolve`, { method: 'POST', token: tokenFor(OTHER) })).status, 404);
    const done = await call(`/api/requests/${mine.id}/resolve`, { method: 'POST', token: tokenFor(ME) });
    assert.equal(done.status, 200);
    const d = (await done.json()) as Record<string, any>;
    assert.equal(d.status, 'completed');
    assert.equal(d.can_resolve, false);
    assert.equal(d.can_complain, false);
    assert.equal((await call(`/api/requests/${mine.id}/resolve`, { method: 'POST', token: tokenFor(ME) })).status, 409);
  });

  it('сбой базы при подаче — 500, повтор после восстановления создаёт заявку', async () => {
    store.apartments.set(ME, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    const original = store.createRequest;
    store.createRequest = async () => {
      throw new Error('SQLITE_BUSY');
    };
    const body = JSON.stringify({ description: 'Не работает лифт', category: 'elevator' });
    assert.equal((await call('/api/requests', { method: 'POST', token: tokenFor(ME), body })).status, 500);
    store.createRequest = original;
    assert.equal((await call('/api/requests', { method: 'POST', token: tokenFor(ME), body })).status, 201);
  });

  it('лимит запросов на пользователя → 429', async () => {
    const t = tokenFor('99999');
    const codes: number[] = [];
    for (let i = 0; i < 42; i++) codes.push((await call('/api/me', { token: t })).status);
    assert.ok(codes.slice(0, 40).every((c) => c === 200));
    assert.equal(codes[41], 429);
  });

  it('/app: index.html без кеша, SPA-маршруты, файлы сборки; неизвестный /api → 404', async () => {
    const idx = await call('/app');
    assert.equal(idx.status, 200);
    assert.equal(idx.headers.get('cache-control'), 'no-cache');
    assert.match(await idx.text(), /<title>app/);
    assert.equal((await call('/app/requests/123')).status, 200);
    const js = await call('/app/assets/main-abc.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await call('/api/nope')).status, 404);
  });
});
