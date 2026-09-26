import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { issueSessionToken, linkSecret, verifySessionToken } from '../auth/sessionToken.js';
import { validateWebAppData } from '../auth/webAppData.js';
import type { ApartmentInfo, BotStore, ChatMessage, OrgInfo, RequestInfo } from '../bot/store.js';
import { formatAddress, matchHouse } from '../domain/address.js';
import { parseApartmentNumber } from '../bot/bot.js';
import { complaintText } from '../domain/complaint.js';
import { MAX_PHOTOS } from '../domain/photos.js';
import { CATEGORY_ORDER, NORMS } from '../domain/norms.js';
import { buildNotifications, requestTimeline, TIMELINE_LABEL } from '../domain/timeline.js';
import { MAX_DESCRIPTION, MIN_DESCRIPTION, submitRequest, suggestCategory } from '../requests/service.js';
import { effectiveStatus, OPEN_STATUSES, STATUS_LABEL } from '../domain/requestStatus.js';
import { CONTENT_TYPES, MAX_PHOTO_BYTES, sniffImage, type PhotoStorage } from '../photos/storage.js';
import { SlidingWindowLimiter } from '../webhook/rateLimit.js';

/**
 * API мини-приложения (ТЗ 5.2, этапы 6–7).
 *
 * Вход: POST /api/auth/session { web_app_data } — подписанные MAX стартовые данные → сессионный токен.
 * Дальше каждый запрос — с Authorization: Bearer <token>. Пользователь берётся ТОЛЬКО из проверенного
 * токена; ни один маршрут не принимает его идентификатор от клиента. Чужая заявка — 404, не 403.
 *
 * CORS не включён: мини-приложение отдаётся этим же сервером (/app), запросы — с того же адреса.
 */

export interface ApiDeps {
  store: BotStore;
  logger: Logger;
  botToken: string;
  sessionSecret: string;
  sessionTtlSec: number;
  demoStatuses?: boolean;
  now?: () => Date;
  /** Лимиты: на токен для /api/* (ТЗ 9.2 — 60/мин) и на IP для входа. */
  perUserPerMin?: number;
  /** Файлы фото заявок. */
  photoStorage?: PhotoStorage;
  sessionPerIpPerMin?: number;
  chatPerMin?: number;
}

const SessionBody = z.object({ web_app_data: z.string().min(1).max(8192) });
const LinkBody = z.object({ code: z.string().min(1).max(2048) });
const RequestId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const NewRequestBody = z.object({ description: z.string().max(4000), category: z.string().max(32) });
const SuggestBody = z.object({ description: z.string().max(4000) });
const RatingBody = z.object({ value: z.number().int().min(1).max(5), comment: z.string().max(2000).nullable().optional() });
const ChatBody = z.object({ text: z.string().max(4000) });
const NotifyBody = z.object({ on: z.boolean() });
export const MAX_CHAT_TEXT = 1000;
export const MAX_RATING_COMMENT = 500;
const ApartmentBody = z.object({
  house_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  number: z.string().max(20),
  entrance: z.number().int().min(1).max(50).nullable().optional(),
});

type Locals = { userId: string };

function orgView(o: OrgInfo | null, withContacts: boolean) {
  if (!o) return null;
  const contacts = withContacts && o.verified;
  return {
    name: o.name,
    verified: o.verified,
    demo: !!o.demo,
    // Телефоны — только из проверенных данных, как и в боте.
    phone: contacts ? o.phone : null,
    dispatcher_phone: contacts ? o.dispatcherPhone : null,
    working_hours: contacts ? o.workingHours : null,
  };
}

function apartmentView(a: ApartmentInfo, rating: { avg: number; count: number } | null = null) {
  const h = a.house;
  return {
    address: formatAddress(h),
    full_address: `${h.fullAddress}, кв. ${a.number}`,
    number: a.number,
    entrance: a.entrance,
    house: {
      code: h.code,
      year_built: h.yearBuilt,
      floors: h.floors,
      entrances: h.entrances,
      apartments_count: h.apartmentsCount,
      data_verified: h.verified,
    },
    uk: h.manager ? { ...orgView(h.manager, true)!, rating: rating ? { avg: Math.round(rating.avg * 10) / 10, count: rating.count } : null } : null,
  };
}

/** Сообщение чата дома для соседей: имя, ник и фото профиля MAX — без user_id и без квартиры. */
function chatMessageView(m: ChatMessage) {
  return {
    id: m.id,
    text: m.text,
    deleted: m.text === null,
    at: m.createdAt.toISOString(),
    mine: m.mine,
    author: {
      key: m.author.key,
      name: m.author.name ?? 'Сосед',
      username: m.author.username,
      photo_url: m.author.photoUrl,
    },
  };
}

/** Пробелы по краям, не больше двух пустых строк подряд, без управляющих символов. */
export function cleanChatText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function requestView(r: RequestInfo, now: Date, demo: boolean) {
  const status = effectiveStatus(r, now, demo);
  const norm = r.category === 'gas' ? null : NORMS[r.category];
  const open = OPEN_STATUSES.includes(status);
  return {
    id: r.id,
    number: r.number,
    category: r.category,
    category_title: norm?.title ?? 'Газ',
    description: r.description,
    status,
    status_label: STATUS_LABEL[status],
    status_is_demo: status !== r.status,
    can_cancel: open,
    // «Проблема решена» — по открытой; жалоба в ГЖИ — когда срок истёк
    can_resolve: open,
    can_complain: open && r.dueAt <= now,
    // Оценка — после выполнения (не после отзыва или отказа), один раз
    can_rate: r.status === 'completed' && !r.rating,
    rating: r.rating ? { value: r.rating.value, comment: r.rating.comment, at: r.rating.at.toISOString() } : null,
    created_at: r.createdAt.toISOString(),
    due_at: r.dueAt.toISOString(),
    overdue: open && r.dueAt <= now,
    org: orgView(r.org, false),
    norm: norm ? { what: norm.what, ref: norm.ref } : null,
    address: r.address,
    // Только id и наличие файла: ссылки и токены MAX клиенту не отдаём
    photos: r.photos.map((p) => ({ id: p.id, available: !!p.file })),
    timeline: requestTimeline(r, now, demo).map((e) => ({
      type: e.type,
      at: e.at.toISOString(),
      label: e.type === 'rated' && r.rating ? `Ваша оценка: ${r.rating.value} из 5` : TIMELINE_LABEL[e.type],
      future: !!e.future,
      demo: !!e.demo,
    })),
  };
}

export function createApiRouter(deps: ApiDeps) {
  const log = deps.logger.child({ module: 'api' });
  const clock = deps.now ?? (() => new Date());
  const userLimiter = new SlidingWindowLimiter(deps.perUserPerMin ?? 60);
  // Чат: не больше 10 сообщений в минуту от одного жильца — против флуда.
  const chatLimiter = new SlidingWindowLimiter(deps.chatPerMin ?? 10);
  const ipLimiter = new SlidingWindowLimiter(deps.sessionPerIpPerMin ?? 30);
  setInterval(() => (userLimiter.sweep(), ipLimiter.sweep(), chatLimiter.sweep()), 60_000).unref();

  const router = express.Router();

  router.use((_req, res, next) => {
    // Ответы персональные: ни браузер, ни прокси не должны их кешировать.
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/auth/session', express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    if (!ipLimiter.allow(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const body = SessionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Нужно поле web_app_data' });
      return;
    }
    const v = validateWebAppData(body.data.web_app_data, deps.botToken, { nowMs: clock().getTime() });
    if (!v.ok) {
      log.warn({ reason: v.reason }, `api: вход в мини-приложение отклонён — ${v.reason}`);
      res.status(401).json({ error: 'invalid_web_app_data', reason: v.reason });
      return;
    }
    const name = [v.user.firstName, v.user.lastName].filter(Boolean).join(' ') || undefined;
    await deps.store.ensureUser(v.user.userId, { name, username: v.user.username ?? '', photoUrl: v.user.photoUrl ?? '' });
    const token = issueSessionToken(v.user.userId, deps.sessionSecret, deps.sessionTtlSec, clock().getTime());
    log.info({ userId: v.user.userId }, 'api: вход в мини-приложение');
    res.json({ token, expires_in: deps.sessionTtlSec, user: { first_name: v.user.firstName ?? null } });
  });

  // Запасной вход: одноразовая ссылка из бота (если мини-приложение открыто не из MAX, а браузером).
  const linkKey = linkSecret(deps.sessionSecret);
  router.post('/auth/link', express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    if (!ipLimiter.allow(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const body = LinkBody.safeParse(req.body);
    const link = body.success ? verifySessionToken(body.data.code, linkKey, clock().getTime()) : null;
    if (!link) {
      res.status(401).json({ error: 'invalid_link' });
      return;
    }
    await deps.store.ensureUser(link.sub);
    const token = issueSessionToken(link.sub, deps.sessionSecret, deps.sessionTtlSec, clock().getTime());
    log.info({ userId: link.sub }, 'api: вход в мини-приложение по ссылке из бота');
    res.json({ token, expires_in: deps.sessionTtlSec, user: { first_name: null } });
  });

  const auth = (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const s = verifySessionToken(header.slice(7), deps.sessionSecret, clock().getTime());
    if (!s) {
      res.status(401).json({ error: 'token_invalid_or_expired' });
      return;
    }
    if (!userLimiter.allow(s.sub)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    res.locals.userId = s.sub;
    next();
  };

  router.get('/me', auth, async (_req, res: Response<unknown, Locals>) => {
    const a = await deps.store.getApartment(res.locals.userId);
    res.json({ apartment: a ? apartmentView(a, await deps.store.ukRating(res.locals.userId)) : null });
  });

  // ── смена адреса (то же, что «Сменить адрес» в боте) ────────────────────

  /** Поиск дома по справочнику: тот же разбор, что в боте (опечатки, «корп.», дроби). */
  router.get('/houses/search', auth, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const houses = await deps.store.listHouses();
    const view = (h: (typeof houses)[number]) => ({
      id: h.id,
      address: formatAddress(h),
      entrances: h.entrances,
      uk: h.manager ? { name: h.manager.name, verified: h.manager.verified } : null,
    });
    if (q.trim().length < 2) {
      res.json({ kind: 'empty', houses: [], total: houses.length });
      return;
    }
    const m = matchHouse(q, houses);
    res.json({
      kind: m.kind,
      street: 'street' in m ? m.street : null,
      apartment: m.query.apartment ?? null,
      houses: m.kind === 'not_found' ? [] : m.houses.slice(0, 20).map(view),
      total: houses.length,
    });
  });

  router.put('/me/apartment', auth, express.json({ limit: '4kb' }), async (req, res: Response<unknown, Locals>) => {
    const body = ApartmentBody.safeParse(req.body);
    const house = body.success ? await deps.store.getHouse(body.data.house_id) : null;
    const number = body.success ? parseApartmentNumber(body.data.number) : null;
    if (!body.success || !house) {
      res.status(400).json({ error: 'bad_house' });
      return;
    }
    if (!number) {
      res.status(400).json({ error: 'bad_number' });
      return;
    }
    const entrance = body.data.entrance ?? null;
    if (entrance !== null && house.entrances && entrance > house.entrances) {
      res.status(400).json({ error: 'bad_entrance' });
      return;
    }
    await deps.store.ensureUser(res.locals.userId);
    await deps.store.saveApartment(res.locals.userId, { houseId: house.id, number, entrance });
    log.info({ userId: res.locals.userId, house: house.code }, 'api: адрес изменён в мини-приложении');
    const a = await deps.store.getApartment(res.locals.userId);
    res.json({ apartment: a ? apartmentView(a, await deps.store.ukRating(res.locals.userId)) : null });
  });

  router.get('/requests', auth, async (_req, res: Response<unknown, Locals>) => {
    const now = clock();
    const list = await deps.store.listRequests(res.locals.userId, 50);
    res.json({ items: list.map((r) => requestView(r, now, !!deps.demoStatuses)) });
  });

  router.get('/requests/:id', auth, async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    // Фильтр по пользователю — в самом запросе к БД: чужая заявка просто не находится (ТЗ 5.2.2).
    const r = id.success ? await deps.store.getRequest(res.locals.userId, id.data) : null;
    if (!r) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(requestView(r, clock(), !!deps.demoStatuses));
  });

  // Уведомления: новые статусы своих заявок и «Соседи уже сообщили» (заявки из того же дома за неделю)
  router.get('/notifications', auth, async (_req, res: Response<unknown, Locals>) => {
    const now = clock();
    const [own, neighbors] = await Promise.all([
      deps.store.listRequests(res.locals.userId, 50),
      deps.store.houseActivity(res.locals.userId, new Date(now.getTime() - 7 * 86_400_000)),
    ]);
    const items = buildNotifications(own, neighbors, now, !!deps.demoStatuses);
    res.json({
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind,
        at: n.at.toISOString(),
        title: n.title,
        text: n.text,
        request_id: n.requestId ?? null,
        category: n.category ?? null,
      })),
    });
  });

  // ── подача заявки из мини-приложения ────────────────────────────────────

  router.get('/catalog', auth, (_req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({
      categories: CATEGORY_ORDER.map((c) => ({
        id: c, title: NORMS[c].title, what: NORMS[c].what, ref: NORMS[c].ref, org_type: NORMS[c].orgType,
      })),
      max_photos: MAX_PHOTOS,
      min_description: MIN_DESCRIPTION,
      max_description: MAX_DESCRIPTION,
    });
  });

  router.post('/requests/suggest', auth, express.json({ limit: '16kb' }), (req, res) => {
    const body = SuggestBody.safeParse(req.body);
    const category = body.success ? suggestCategory(body.data.description) : null;
    res.json({ category: category === 'gas' ? null : category, gas: category === 'gas' });
  });

  router.post('/requests', auth, express.json({ limit: '16kb' }), async (req, res: Response<unknown, Locals>) => {
    const body = NewRequestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const r = await submitRequest(deps.store, res.locals.userId, body.data, clock());
    if (!r.ok) {
      const status = r.reason === 'no_apartment' ? 409 : r.reason === 'gas' ? 422 : 400;
      res.status(status).json({ error: r.reason });
      return;
    }
    if (!r.duplicate) log.info({ userId: res.locals.userId, number: r.request.number }, `api: заявка ${r.request.number} создана в мини-приложении (${r.request.category})`);
    res.status(r.duplicate ? 200 : 201).json(requestView(r.request, clock(), !!deps.demoStatuses));
  });

  // Фото — отдельными запросами после создания заявки: тело — сами байты картинки (мини-приложение
  // сжимает её до ~1600 px). Тип определяем по сигнатуре файла, заголовку клиента не верим.
  router.post(
    '/requests/:id/photos',
    auth,
    express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }),
    async (req, res: Response<unknown, Locals>) => {
      const id = RequestId.safeParse(req.params.id);
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!id.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!sniffImage(buf) || !deps.photoStorage) {
        res.status(400).json({ error: 'not_image' });
        return;
      }
      const added = await deps.store.addPhoto(res.locals.userId, id.data);
      if (!added.ok) {
        res.status(added.reason === 'not_found' ? 404 : 409).json({ error: added.reason });
        return;
      }
      const file = await deps.photoStorage.save(buf, added.id);
      if (!file) {
        res.status(500).json({ error: 'save_failed' });
        return;
      }
      await deps.store.setPhotoFile(added.id, file);
      res.status(201).json({ id: added.id });
    },
  );

  router.post('/requests/:id/resolve', auth, async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    const r = id.success ? await deps.store.getRequest(res.locals.userId, id.data) : null;
    if (!r) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!OPEN_STATUSES.includes(r.status)) {
      res.status(409).json({ error: 'already_closed' });
      return;
    }
    await deps.store.setRequestStatus(res.locals.userId, r.id, 'completed');
    log.info({ userId: res.locals.userId, number: r.number }, `api: заявка ${r.number} закрыта жильцом как решённая`);
    res.json(requestView((await deps.store.getRequest(res.locals.userId, r.id))!, clock(), !!deps.demoStatuses));
  });

  router.get('/requests/:id/complaint', auth, async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    const r = id.success ? await deps.store.getRequest(res.locals.userId, id.data) : null;
    if (!r || r.category === 'gas') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      text: complaintText({
        description: r.description,
        address: `${r.house.fullAddress.split(',')[0]}, ${r.address}`,
        orgName: r.org ? r.org.name : null,
        norm: NORMS[r.category],
        createdAt: r.createdAt,
        dueAt: r.dueAt,
        photos: r.photos.length,
      }),
      where: 'Подать жалобу можно через Госуслуги или ГИС ЖКХ (dom.gosuslugi.ru), либо письмом в ГЖИ Республики Татарстан.',
      note: 'В тестовом режиме сервис не передаёт заявки в УК. Жалоба имеет смысл, если вы обращались в УК сами — укажите дату и способ обращения.',
    });
  });

  // Фото заявки: только своей, только с нашего диска. Картинки в <img> не шлют заголовок
  // Authorization, поэтому мини-приложение забирает их fetch-ем и показывает как blob.
  router.get('/requests/:id/photos/:photoId', auth, async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    const photoId = RequestId.safeParse(req.params.photoId);
    const r = id.success && photoId.success ? await deps.store.getRequest(res.locals.userId, id.data) : null;
    const photo = r?.photos.find((p) => p.id === photoId.data);
    const file = photo?.file ? deps.photoStorage?.resolve(photo.file) : null;
    if (!file) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(CONTENT_TYPES[file.split('.').pop()!] ?? 'application/octet-stream');
    res.sendFile(file);
  });

  // Отзыв заявки жильцом. Это не «смена статуса» из ТЗ v1.0 (её убрали из публичного API):
  // только своя заявка, только из открытой в «отозвана», условие — в самом запросе к БД.
  router.post('/requests/:id/cancel', auth, async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    const result = id.success ? await deps.store.cancelRequest(res.locals.userId, id.data) : 'not_found';
    if (result === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const r = await deps.store.getRequest(res.locals.userId, id.data!);
    if (result === 'closed') {
      res.status(409).json({ error: 'already_closed', request: r ? requestView(r, clock(), !!deps.demoStatuses) : null });
      return;
    }
    log.info({ userId: res.locals.userId, number: r?.number }, `api: заявка ${r?.number} отозвана жильцом`);
    res.json(requestView(r!, clock(), !!deps.demoStatuses));
  });

  // ── оценка после закрытия ───────────────────────────────────────────────

  router.post('/requests/:id/rating', auth, express.json({ limit: '8kb' }), async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    const body = RatingBody.safeParse(req.body);
    if (!id.success) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: 'bad_rating' });
      return;
    }
    const comment = cleanChatText(body.data.comment ?? '').slice(0, MAX_RATING_COMMENT) || null;
    const result = await deps.store.rateRequest(res.locals.userId, id.data, { value: body.data.value, comment }, clock());
    if (result === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const r = await deps.store.getRequest(res.locals.userId, id.data);
    if (result !== 'ok') {
      res.status(409).json({ error: result, request: r ? requestView(r, clock(), !!deps.demoStatuses) : null });
      return;
    }
    log.info({ userId: res.locals.userId, number: r?.number, rating: body.data.value }, `api: заявка ${r?.number} оценена на ${body.data.value}`);
    res.json(requestView(r!, clock(), !!deps.demoStatuses));
  });

  // ── чат дома ────────────────────────────────────────────────────────────
  // Участники — жильцы с привязанной квартирой в доме. Соседям видны имя, ник и фото профиля MAX;
  // user_id MAX и номер квартиры не отдаются никому.

  router.get('/chat', auth, async (req, res: Response<unknown, Locals>) => {
    const beforeRaw = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
    const before = beforeRaw && !Number.isNaN(beforeRaw.getTime()) ? beforeRaw : undefined;
    const [view, apt, chatId] = await Promise.all([
      deps.store.chatView(res.locals.userId, { limit: 50, before }),
      deps.store.getApartment(res.locals.userId),
      deps.store.getChatId(res.locals.userId),
    ]);
    if (!view || !apt) {
      res.json({ available: false });
      return;
    }
    // Открыли чат (первая страница) — всё прочитано.
    if (!before) await deps.store.markChatRead(res.locals.userId, clock());
    res.json({
      available: true,
      address: formatAddress(apt.house),
      members: view.members,
      notify: view.notify,
      // Уведомления приходят сообщением от бота — нужен диалог с ним.
      can_notify: !!chatId,
      has_more: view.hasMore,
      last_read_at: view.lastReadAt?.toISOString() ?? null,
      max_text: MAX_CHAT_TEXT,
      messages: view.messages.map(chatMessageView),
    });
  });

  router.get('/chat/unread', auth, async (_req, res: Response<unknown, Locals>) => {
    res.json({ count: await deps.store.chatUnread(res.locals.userId) });
  });

  router.post('/chat', auth, express.json({ limit: '16kb' }), async (req, res: Response<unknown, Locals>) => {
    const body = ChatBody.safeParse(req.body);
    const text = body.success ? cleanChatText(body.data.text) : '';
    if (!text) {
      res.status(400).json({ error: 'empty' });
      return;
    }
    if (text.length > MAX_CHAT_TEXT) {
      res.status(400).json({ error: 'too_long' });
      return;
    }
    if (!chatLimiter.allow(res.locals.userId)) {
      res.status(429).json({ error: 'too_fast' });
      return;
    }
    const m = await deps.store.postChat(res.locals.userId, text, clock());
    if (!m) {
      res.status(409).json({ error: 'no_apartment' });
      return;
    }
    res.status(201).json(chatMessageView(m));
  });

  router.delete('/chat/:id', auth, async (req, res: Response<unknown, Locals>) => {
    const id = RequestId.safeParse(req.params.id);
    const ok = id.success && (await deps.store.deleteChat(res.locals.userId, id.data, clock()));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
  });

  router.put('/chat/notify', auth, express.json({ limit: '1kb' }), async (req, res: Response<unknown, Locals>) => {
    const body = NotifyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    await deps.store.setChatNotify(res.locals.userId, body.data.on);
    res.json({ notify: body.data.on });
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}
