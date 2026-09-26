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

  it('уведомления: свои статусы и «соседи уже сообщили» — без чужого текста и квартиры; хронология в карточке', async () => {
    const house = HOUSES.find((h) => h.code === 'kzn_0018')!.id;
    store.apartments.set(ME, { houseId: house, number: '42', entrance: 2 });
    store.apartments.set(OTHER, { houseId: house, number: '7', entrance: 1 });
    store.apartments.set('far', { houseId: HOUSES[1]!.id, number: '1', entrance: null });
    await store.createRequest(OTHER, { address: 'ул. Баумана, д. 15, кв. 7', category: 'elevator', description: 'СЕКРЕТНЫЙ текст соседа', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    await store.createRequest('far', { address: 'x', category: 'roof', description: 'другой дом', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    const mine = await store.createRequest(ME, { address: 'a', category: 'heating', description: 'Течёт батарея', orgType: 'UK', dueAt: new Date(clock.now + 3_600_000) });
    clock.now += 2 * 3_600_000;
    const res = await call('/api/notifications', { token: tokenFor(ME) });
    const raw = await res.text();
    assert.doesNotMatch(raw, /СЕКРЕТНЫЙ|кв\. 7|другой дом/, 'чужие тексты и квартиры не утекают');
    const { items } = JSON.parse(raw) as { items: Array<Record<string, any>> };
    assert.ok(items.some((n) => n.kind === 'neighbors' && n.text === '1 заявка «Лифт» в вашем доме за неделю' && n.category === 'elevator'));
    assert.ok(!items.some((n) => /Крыша/.test(n.text)), 'заявки из другого дома не показываются');
    assert.ok(items.some((n) => n.kind === 'status' && n.request_id === mine.id && n.text === 'Срок истёк'));
    const card = (await (await call(`/api/requests/${mine.id}`, { token: tokenFor(ME) })).json()) as { timeline: Array<{ type: string; label: string }> };
    assert.deepEqual(card.timeline.map((e) => e.type), ['created', 'accepted', 'in_progress', 'overdue']);
    clock.now -= 2 * 3_600_000;
  });

  it('смена адреса в приложении: поиск по справочнику, проверка номера и подъезда, старые заявки с прежним адресом', async () => {
    const t = tokenFor(ME);
    const search = async (q: string) => (await (await call(`/api/houses/search?q=${encodeURIComponent(q)}`, { token: t })).json()) as { kind: string; houses: Array<{ id: string; address: string; entrances: number | null }>; apartment: string | null };
    const found = await search('Бауманна 15 кв 7');
    assert.equal(found.kind, 'found');
    assert.equal(found.houses[0]!.address, 'ул. Баумана, д. 15');
    assert.equal(found.apartment, '7');
    assert.equal((await search('Ленина 5')).kind, 'not_found');
    const street = await search('Баумана');
    assert.equal(street.kind, 'need_number');
    assert.ok(street.houses.length > 1);

    store.apartments.set(ME, { houseId: HOUSES[1]!.id, number: '3', entrance: null });
    const old = await store.createRequest(ME, { address: 'старый адрес, кв. 3', category: 'roof', description: 'Крыша', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    const put = (body: unknown) => call('/api/me/apartment', { method: 'PUT', token: t, body: JSON.stringify(body) });
    assert.deepEqual(await (await put({ house_id: found.houses[0]!.id, number: 'сорок' })).json(), { error: 'bad_number' });
    assert.deepEqual(await (await put({ house_id: 'нет-такого', number: '7' })).json(), { error: 'bad_house' });
    assert.deepEqual(await (await put({ house_id: found.houses[0]!.id, number: '7', entrance: 20 })).json(), { error: 'bad_entrance' });
    const ok = await put({ house_id: found.houses[0]!.id, number: 'кв. 7', entrance: 2 });
    assert.equal(ok.status, 200);
    const { apartment } = (await ok.json()) as { apartment: { address: string; number: string; entrance: number } };
    assert.deepEqual([apartment.address, apartment.number, apartment.entrance], ['ул. Баумана, д. 15', '7', 2]);
    assert.equal((await store.getRequest(ME, old.id))!.address, 'старый адрес, кв. 3', 'поданная заявка — с прежним адресом');
    assert.equal((await call('/api/houses/search?q=x')).status, 401);
  });

  it('оценка: только выполненной заявки, один раз; средняя оценка УК в /me; время закрытия не сдвигается', async () => {
    const RU = '67001';
    const t = tokenFor(RU);
    store.apartments.set(RU, { houseId: HOUSES[0]!.id, number: '42', entrance: null });
    const r = await store.createRequest(RU, { address: 'а', category: 'heating', description: 'Течёт батарея', orgType: 'UK', dueAt: new Date(clock.now + 86_400_000) });
    const rate = (body: unknown, id = r.id) => call(`/api/requests/${id}/rating`, { method: 'POST', token: t, body: JSON.stringify(body) });
    const open = await rate({ value: 5 });
    assert.equal(open.status, 409);
    assert.equal(((await open.json()) as { error: string }).error, 'not_completed');
    const before = (await (await call(`/api/requests/${r.id}`, { token: t })).json()) as { can_rate: boolean };
    assert.equal(before.can_rate, false, 'открытую не оценить');

    await call(`/api/requests/${r.id}/resolve`, { method: 'POST', token: t });
    const closedAt = store.requests.find((x) => x.id === r.id)!.updatedAt.getTime();
    assert.equal((await rate({ value: 6 })).status, 400);
    assert.equal((await rate({ value: 0 })).status, 400);
    clock.now += 60_000;
    const ok = await rate({ value: 4, comment: '  Пришли быстро,\n\n\n\nно грязь оставили  ' });
    assert.equal(ok.status, 200);
    const card = (await ok.json()) as { can_rate: boolean; rating: { value: number; comment: string }; timeline: Array<{ type: string; label: string }> };
    assert.equal(card.can_rate, false);
    assert.deepEqual([card.rating.value, card.rating.comment], [4, 'Пришли быстро,\n\nно грязь оставили']);
    assert.equal(card.timeline.at(-1)!.label, 'Ваша оценка: 4 из 5');
    assert.equal(store.requests.find((x) => x.id === r.id)!.updatedAt.getTime(), closedAt, 'время закрытия то же');
    const again = await rate({ value: 1 });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, 'already');
    assert.equal((await rate({ value: 5 }, 'чужая-или-нет')).status, 404);
    // Чужую заявку не оценить
    assert.equal((await call(`/api/requests/${r.id}/rating`, { method: 'POST', token: tokenFor(OTHER), body: JSON.stringify({ value: 1 }) })).status, 404);

    const me = (await (await call('/api/me', { token: t })).json()) as { apartment: { uk: { rating: { avg: number; count: number } | null } } };
    assert.deepEqual(me.apartment.uk.rating, { avg: 4, count: 1 });
    clock.now -= 60_000;
  });

  it('чат дома: только свой дом, профиль MAX без user_id, удаление своего, непрочитанные, флуд и пустые сообщения', async () => {
    const [A, B, C] = ['70001', '70002', '70003'];
    for (const u of [A, B, C]) store.chatState.delete(u);
    store.chat.length = 0;
    await store.ensureUser(A, { name: 'Анна Петрова', username: 'anna_p', photoUrl: 'https://i.max.ru/a.jpg' });
    await store.ensureUser(B, { name: 'Борис' });
    await store.ensureUser(C, { name: 'Вера' });
    await store.saveApartment(A, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    await store.saveApartment(B, { houseId: HOUSES[0]!.id, number: '2', entrance: null });
    await store.saveApartment(C, { houseId: HOUSES[1]!.id, number: '3', entrance: null });
    const post = (u: string, text: string) => call('/api/chat', { method: 'POST', token: tokenFor(u), body: JSON.stringify({ text }) });

    clock.now += 1000;
    const sent = await post(A, '  Кто знает, когда дадут горячую воду?  ');
    assert.equal(sent.status, 201);
    const m = (await sent.json()) as { id: string; text: string; mine: boolean; author: Record<string, unknown> };
    assert.equal(m.text, 'Кто знает, когда дадут горячую воду?');
    assert.deepEqual(m.author, { key: m.author.key, name: 'Анна Петрова', username: 'anna_p', photo_url: 'https://i.max.ru/a.jpg' });
    assert.ok(!JSON.stringify(m).includes(A), 'user_id MAX соседям не отдаём');

    assert.equal(((await (await call('/api/chat/unread', { token: tokenFor(B) })).json()) as { count: number }).count, 1);
    const chatB = (await (await call('/api/chat', { token: tokenFor(B) })).json()) as { available: boolean; members: number; address: string; messages: Array<{ mine: boolean; author: { name: string } }> };
    assert.equal(chatB.available, true);
    assert.equal(chatB.members, 2);
    assert.equal(chatB.messages.length, 1);
    assert.equal(chatB.messages[0]!.mine, false);
    assert.equal(((await (await call('/api/chat/unread', { token: tokenFor(B) })).json()) as { count: number }).count, 0, 'открыл — прочитал');

    const chatC = (await (await call('/api/chat', { token: tokenFor(C) })).json()) as { messages: unknown[] };
    assert.equal(chatC.messages.length, 0, 'чат другого дома не виден');
    assert.deepEqual(await (await call('/api/chat', { token: tokenFor('70009') })).json(), { available: false });
    assert.equal((await post('70009', 'привет')).status, 409, 'без квартиры писать нельзя');

    assert.equal((await post(B, '   ')).status, 400);
    assert.equal((await post(B, 'а'.repeat(1001))).status, 400);
    assert.equal((await call(`/api/chat/${m.id}`, { method: 'DELETE', token: tokenFor(B) })).status, 404, 'чужое не удалить');
    assert.equal((await call(`/api/chat/${m.id}`, { method: 'DELETE', token: tokenFor(A) })).status, 200);
    const afterDel = (await (await call('/api/chat', { token: tokenFor(B) })).json()) as { messages: Array<{ text: string | null; deleted: boolean }> };
    assert.deepEqual([afterDel.messages[0]!.text, afterDel.messages[0]!.deleted], [null, true]);

    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(C, `сообщение ${i}`)).status);
    assert.deepEqual([codes[9], codes[10]], [201, 429], 'не больше 10 сообщений в минуту');
  });

  it('чат дома: уведомления по желанию — сводка ботом не чаще раза в 10 минут, при смене дома — новый чат', async () => {
    const [A, B] = ['71001', '71002'];
    store.chat.length = 0;
    await store.ensureUser(A, { name: 'Анна' });
    await store.saveApartment(A, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    await store.saveApartment(B, { houseId: HOUSES[0]!.id, number: '2', entrance: null });
    const tB = tokenFor(B);
    clock.now += 1000;
    await store.postChat(A, 'до включения уведомлений', new Date(clock.now));
    assert.equal((await store.chatDigests(new Date(clock.now), 600_000)).filter((d) => d.maxUserId === B).length, 0, 'по умолчанию выключены');

    const on = await call('/api/chat/notify', { method: 'PUT', token: tB, body: JSON.stringify({ on: true }) });
    assert.deepEqual(await on.json(), { notify: true });
    assert.equal(((await (await call('/api/chat', { token: tB })).json()) as { notify: boolean }).notify, true);
    clock.now += 11 * 60_000;
    await store.postChat(A, 'Лифт снова стоит', new Date(clock.now));
    await store.postChat(A, 'Позвонила в УК', new Date(clock.now + 1));
    const digests = (await store.chatDigests(new Date(clock.now + 2), 600_000)).filter((d) => d.maxUserId === B);
    assert.equal(digests.length, 1);
    assert.deepEqual([digests[0]!.count, digests[0]!.last], [2, { name: 'Анна', text: 'Позвонила в УК' }], 'старое сообщение (до включения) не в сводке');
    await store.markChatNotified(B, new Date(clock.now + 2));
    await store.postChat(A, 'ещё одно', new Date(clock.now + 3));
    assert.equal((await store.chatDigests(new Date(clock.now + 60_000), 600_000)).filter((d) => d.maxUserId === B).length, 0, 'тишина 10 минут');

    await call('/api/chat/notify', { method: 'PUT', token: tB, body: JSON.stringify({ on: false }) });
    assert.equal((await store.chatDigests(new Date(clock.now + 3_600_000), 600_000)).filter((d) => d.maxUserId === B).length, 0, 'выключил — тишина');

    // Переезд: в новом доме старые сообщения не считаются непрочитанными
    await store.postChat(A, 'в старом доме', new Date(clock.now + 4));
    clock.now += 60_000;
    await store.saveApartment(A, { houseId: HOUSES[1]!.id, number: '9', entrance: null });
    await store.saveApartment(B, { houseId: HOUSES[1]!.id, number: '9', entrance: null });
    assert.equal(await store.chatUnread(B), 0);
    clock.now -= 12 * 60_000 + 2000;
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
