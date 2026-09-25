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
import { createBot, type BotIO } from '../src/bot/bot.js';
import type { Db } from '../src/db.js';
import { extractPhotos } from '../src/domain/photos.js';
import type { Button } from '../src/max/keyboard.js';
import { createPhotoStorage } from '../src/photos/storage.js';
import type { ParsedEvent } from '../src/webhook/parser.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';

const log = pino({ level: 'silent' });
const U = '555';
let seq = 0;
const img = (n: number) => ({ type: 'image', payload: { photo_id: 1000 + n, token: `tok${n}`, url: `https://i.max.example/p${n}.jpg` } });
const msg = (text: string, attachments: ParsedEvent['attachments'] = []): ParsedEvent => ({
  type: 'message', dedupKey: `m${seq++}`, user: { userId: U }, userId: U, chatId: 'c', text, attachments, timestamp: 1,
});
const tap = (payload: string): ParsedEvent => ({ type: 'callback', dedupKey: `c${seq++}`, user: { userId: U }, userId: U, chatId: 'c', payload, callbackId: `cb${seq}`, timestamp: 1 });
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

describe('фото в заявке (бот)', () => {
  let store: ReturnType<typeof memoryStore>;
  let out: Array<{ text: string; buttons: string[] }>;
  let sentPhotos: string[][];
  let downloaded: string[];
  let bot: ReturnType<typeof createBot>;

  beforeEach(() => {
    clock.now = Date.parse('2026-09-24T09:00:00Z');
    store = memoryStore();
    store.apartments.set(U, { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    out = [];
    sentPhotos = [];
    downloaded = [];
    const io: BotIO = {
      send: async (_c, text, kb?: Button[][]) => void out.push({ text, buttons: (kb ?? []).flat().map((b) => b.text) }),
      answer: async () => {},
      sendPhotos: async (_c, _t, tokens) => void sentPhotos.push(tokens),
    };
    bot = createBot({
      store, io, logger: log,
      options: { now: () => new Date(clock.now), photoStorage: { download: async (url, id) => (downloaded.push(url), `${id}.jpg`) } },
    });
  });
  const last = () => out.at(-1)!;

  it('фото с подписью — сразу превью с фото; «Отправить» — фото в заявке и на диске', async () => {
    await bot(msg('Течёт батарея в комнате', [img(1)]));
    assert.match(last().text, /Проверьте заявку[\s\S]*Фото: 1/);
    assert.ok(last().buttons.includes('Добавить ещё фото'));
    await bot(tap('req:send'));
    assert.match(last().text, /Заявка REQ-2026-00001 зарегистрирована[\s\S]*Фото: 1 — приложены к заявке/);
    assert.equal(store.requests[0]!.photos.length, 1);
    assert.deepEqual(downloaded, ['https://i.max.example/p1.jpg']);
    assert.equal(store.requests[0]!.photos[0]!.file, `${store.requests[0]!.photos[0]!.id}.jpg`);
  });

  it('сначала фото, потом текст; в превью ещё фото; лимит 5', async () => {
    await bot(msg('', [img(1)]));
    assert.match(last().text, /Фото добавлено \(1 из 5\)[\s\S]*опишите проблему/);
    await bot(msg('Протекает крыша'));
    assert.match(last().text, /Фото: 1/);
    await bot(tap('req:photo'));
    assert.match(last().text, /Пришлите фото сюда/);
    await bot(msg('', [img(2), img(3)]));
    assert.match(last().text, /^Фото добавлено \(3 из 5\)[\s\S]*Фото: 3/);
    await bot(msg('', [img(4), img(5), img(6), img(7)]));
    assert.match(last().text, /Фото добавлено \(5 из 5\)\. Лишние 2 не приложены/);
    assert.ok(!last().buttons.some((b) => /фото/i.test(b)), 'на пределе кнопки «Добавить фото» нет');
    await bot(tap('req:send'));
    assert.equal(store.requests[0]!.photos.length, 5);
  });

  it('фото на шаге выбора категории и при смене категории не теряются', async () => {
    await bot(msg('Хочу узнать про покраску фасада'));
    assert.match(last().text, /Выберите категорию/);
    await bot(msg('', [img(1)]));
    assert.match(last().text, /Фото добавлено \(1 из 5\)\.\nВыберите категорию/);
    await bot(tap('req:cat:other'));
    assert.match(last().text, /Фото: 1/);
    await bot(tap('req:recat'));
    await bot(tap('req:cat:yard'));
    assert.match(last().text, /Двор и территория[\s\S]*Фото: 1/);
  });

  it('«Нет, не решена» — жалоба упоминает фото, бот присылает их по токенам', async () => {
    await bot(msg('Не работает лифт', [img(1), img(2)]));
    await bot(tap('req:send'));
    await bot(tap(`req:unsolved:${store.requests[0]!.id}`));
    assert.match(last().text, /Фотографии прилагаю \(2 шт\.\)/);
    assert.deepEqual(sentPhotos, [['tok1', 'tok2']]);
    await bot(tap('menu:list'));
    assert.match(last().text, /· фото: 2/);
  });

  it('видео — отказ с подсказкой; фото без квартиры или при привязке — не теряем сценарий', async () => {
    await bot(msg('', [{ type: 'video', payload: {} }]));
    assert.match(last().text, /Видео, файлы и стикеры не принимаю/);
    store.apartments.clear();
    await bot(msg('', [img(1)]));
    assert.match(last().text, /сначала привяжем квартиру/);
    await bot(msg('/start'));
    await bot(msg('Баумана 15'));
    await bot(msg('Баумана 15', [img(1)]));
    assert.match(out.at(-2)!.text, /сначала привяжем квартиру/);
    assert.match(last().text, /Нашёл дом/, 'подпись к фото обработана как адрес');
  });

  it('отмена черновика с фото — фото не переходят в следующую заявку', async () => {
    await bot(msg('Не работает лифт', [img(1)]));
    await bot(tap('req:cancel'));
    await bot(msg('Течёт батарея'));
    assert.doesNotMatch(last().text, /Фото:/);
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
