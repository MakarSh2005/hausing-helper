import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { issueSessionToken, linkSecret, verifySessionToken } from '../auth/sessionToken.js';
import { validateWebAppData } from '../auth/webAppData.js';
import type { ApartmentInfo, BotStore, OrgInfo, RequestInfo } from '../bot/store.js';
import { formatAddress } from '../domain/address.js';
import { NORMS } from '../domain/norms.js';
import { effectiveStatus, OPEN_STATUSES, STATUS_LABEL } from '../domain/requestStatus.js';
import { CONTENT_TYPES, type PhotoStorage } from '../photos/storage.js';
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
}

const SessionBody = z.object({ web_app_data: z.string().min(1).max(8192) });
const LinkBody = z.object({ code: z.string().min(1).max(2048) });
const RequestId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

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

function apartmentView(a: ApartmentInfo) {
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
    uk: orgView(h.manager, true),
  };
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
    created_at: r.createdAt.toISOString(),
    due_at: r.dueAt.toISOString(),
    overdue: open && r.dueAt <= now,
    org: orgView(r.org, false),
    norm: norm ? { what: norm.what, ref: norm.ref } : null,
    address: r.address,
    // Только id и наличие файла: ссылки и токены MAX клиенту не отдаём
    photos: r.photos.map((p) => ({ id: p.id, available: !!p.file })),
  };
}

export function createApiRouter(deps: ApiDeps) {
  const log = deps.logger.child({ module: 'api' });
  const clock = deps.now ?? (() => new Date());
  const userLimiter = new SlidingWindowLimiter(deps.perUserPerMin ?? 60);
  const ipLimiter = new SlidingWindowLimiter(deps.sessionPerIpPerMin ?? 30);
  setInterval(() => (userLimiter.sweep(), ipLimiter.sweep()), 60_000).unref();

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
    await deps.store.ensureUser(v.user.userId, v.user.firstName);
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
    res.json({ apartment: a ? apartmentView(a) : null });
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

  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}
