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
import { issueSessionToken } from '../src/auth/sessionToken.js';
import type { Db } from '../src/db.js';
import { extractPhotos } from '../src/domain/photos.js';
import { createPhotoStorage } from '../src/photos/storage.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';

const log = pino({ level: 'silent' });
const img = (n: number) => ({ type: 'image', payload: { photo_id: 1000 + n, token: `tok${n}`, url: `https://i.max.example/p${n}.jpg` } });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe('разбор фото из вложений MAX', () => {
  it('image с token/url/photo_id → фото; прочее — нет', () => {
    assert.deepEqual(extractPhotos([img(1), { type: 'video', payload: { url: 'https://x' } }, { type: 'image', payload: { url: 'http://insecure' } }, { type: 'image' }]), [
      { token: 'tok1', url: 'https://i.max.example/p1.jpg', photoId: '1001' },
    ]);
  });
});

describe('хранилище фото', () => {
  let dir: string;
  beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-'))));
  const fakeFetch = (type: string, body: Buffer, status = 200) =>
    (async () => new Response(new Uint8Array(body), { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('скачивает jpeg и находит его по имени; чужие имена и пути не принимает', async () => {
    const st = createPhotoStorage({ dir, fetchImpl: fakeFetch('image/jpeg', JPEG), logger: log });
    const file = await st.download('https://i.max.example/a.jpg', 'abc-123');
    assert.equal(file, 'abc-123.jpg');
    assert.deepEqual(fs.readFileSync(st.resolve(file!)!), JPEG);
    for (const bad of ['../etc/passwd', 'abc-123.exe', 'a/b.jpg', 'нет.jpg']) assert.equal(st.resolve(bad), null, bad);
  });

  it('не картинка, ошибка, пустой ответ, http — не сохраняет', async () => {
    assert.equal(await createPhotoStorage({ dir, fetchImpl: fakeFetch('text/html', Buffer.from('<html>')), logger: log }).download('https://x/a', 'a1'), null);
    assert.equal(await createPhotoStorage({ dir, fetchImpl: fakeFetch('image/jpeg', JPEG, 404), logger: log }).download('https://x/a', 'a2'), null);
    assert.equal(await createPhotoStorage({ dir, fetchImpl: fakeFetch('image/jpeg', Buffer.alloc(0)), logger: log }).download('https://x/a', 'a3'), null);
    assert.equal(await createPhotoStorage({ dir, fetchImpl: fakeFetch('image/jpeg', JPEG), logger: log }).download('http://x/a', 'a4'), null);
    assert.equal(fs.readdirSync(path.join(dir, 'photos')).length, 0);
  });
});

describe('фото в API мини-приложения', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const store = memoryStore();
  const SECRET = 'f'.repeat(40);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-photos-'));
    const photoStorage = createPhotoStorage({ dir, fetchImpl: (async () => new Response(new Uint8Array(JPEG), { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch, logger: log });
    const api = createApiRouter({ store, logger: log, botToken: 'x'.repeat(20), sessionSecret: SECRET, sessionTtlSec: 3600, photoStorage, now: () => new Date(clock.now) });
    server = createApp({ db: {} as Db, logger: log, webhook: { verify() {}, handler() {}, onBodyError() {} } as never, api }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const u of ['me', 'other']) store.apartments.set(u, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    const r = await store.createRequest('me', { address: 'a', category: 'roof', description: 'Крыша', orgType: 'UK', dueAt: new Date(), photos: [{ token: 't1', url: 'https://x/1.jpg' }, { token: 't2', url: 'https://x/2.jpg' }] });
    const file = await photoStorage.download('https://x/1.jpg', r.photos[0]!.id);
    await store.setPhotoFile(r.photos[0]!.id, file!);
  });
  after(() => server.close());
  const get = (p: string, u: string) => fetch(base + p, { headers: { authorization: `Bearer ${issueSessionToken(u, SECRET, 3600, clock.now)}` } });

  it('в карточке — id и наличие файла, без ссылок и токенов MAX', async () => {
    const r = (await (await get(`/api/requests/${store.requests[0]!.id}`, 'me')).json()) as { photos: Array<Record<string, unknown>> };
    assert.deepEqual(r.photos, [{ id: store.requests[0]!.photos[0]!.id, available: true }, { id: store.requests[0]!.photos[1]!.id, available: false }]);
  });

  const post = (p: string, u: string, body: Uint8Array | string) =>
    fetch(base + p, { method: 'POST', body, headers: { authorization: `Bearer ${issueSessionToken(u, SECRET, 3600, clock.now)}`, 'content-type': 'image/jpeg' } });

  it('загрузка из мини-приложения: картинка по сигнатуре, лимит 5, чужая и закрытая заявка — отказ', async () => {
    const r = await store.createRequest('me', { address: 'a', category: 'yard', description: 'Двор', orgType: 'UK', dueAt: new Date() });
    const up = await post(`/api/requests/${r.id}/photos`, 'me', new Uint8Array(JPEG));
    assert.equal(up.status, 201);
    const { id } = (await up.json()) as { id: string };
    const back = await get(`/api/requests/${r.id}/photos/${id}`, 'me');
    assert.equal(back.status, 200);
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), JPEG);
    assert.equal((await post(`/api/requests/${r.id}/photos`, 'me', '<html>не картинка</html>')).status, 400, 'тип по сигнатуре, не по заголовку');
    assert.equal((await post(`/api/requests/${r.id}/photos`, 'other', new Uint8Array(JPEG))).status, 404, 'в чужую заявку нельзя');
    for (let i = 0; i < 4; i++) assert.equal((await post(`/api/requests/${r.id}/photos`, 'me', new Uint8Array(JPEG))).status, 201);
    assert.deepEqual(await (await post(`/api/requests/${r.id}/photos`, 'me', new Uint8Array(JPEG))).json(), { error: 'limit' });
    await store.cancelRequest('me', r.id);
    const r2 = await store.createRequest('me', { address: 'a', category: 'yard', description: 'Двор 2', orgType: 'UK', dueAt: new Date() });
    await store.cancelRequest('me', r2.id);
    assert.deepEqual(await (await post(`/api/requests/${r2.id}/photos`, 'me', new Uint8Array(JPEG))).json(), { error: 'closed' });
  });

  it('своё фото — картинка; чужой пользователь, нескачанное и мусор — 404; без токена — 401', async () => {
    const req = store.requests[0]!;
    const ok = await get(`/api/requests/${req.id}/photos/${req.photos[0]!.id}`, 'me');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), JPEG);
    assert.equal((await get(`/api/requests/${req.id}/photos/${req.photos[0]!.id}`, 'other')).status, 404);
    assert.equal((await get(`/api/requests/${req.id}/photos/${req.photos[1]!.id}`, 'me')).status, 404);
    assert.equal((await get(`/api/requests/${req.id}/photos/..%2F..%2Fetc`, 'me')).status, 404);
    assert.equal((await fetch(`${base}/api/requests/${req.id}/photos/${req.photos[0]!.id}`)).status, 401);
  });
});
