import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { describeError } from '../max/client.js';
import { markProcessed } from './dedup.js';
import { parseUpdate, type ParsedEvent } from './parser.js';
import type { SlidingWindowLimiter } from './rateLimit.js';

/**
 * POST /webhook (ТЗ 5.1.1, 5.1.4).
 * 1. Сверка X-Max-Bot-Api-Secret, timing-safe → 401 при несовпадении.
 * 2. Немедленный 200 {"ok":true} — до любой обработки.
 * 3. Асинхронно: разбор → rate limit → идемпотентность → upsert пользователя → маршрутизация.
 * Любая внутренняя ошибка логируется, но наружу не выходит: MAX не должен ретраить битое событие.
 */

export type EventRouter = (event: ParsedEvent) => Promise<void>;

export interface WebhookDeps {
  secret: string;
  db: Db;
  logger: Logger;
  limiter: SlidingWindowLimiter;
  route: EventRouter;
  logRawUpdates?: boolean;
}

/**
 * Сравнение, устойчивое к timing-атакам. Сравниваем SHA-256 от обеих строк, чтобы
 * длины буферов всегда совпадали и по времени ответа нельзя было узнать длину секрета.
 */
export function secretMatches(incoming: string | undefined, expected: string): boolean {
  if (!incoming) return false;
  const a = crypto.createHash('sha256').update(incoming).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createWebhookHandler(deps: WebhookDeps) {
  const log = deps.logger.child({ module: 'webhook' });
  /** Незавершённые обработки — чтобы дождаться их при остановке процесса. */
  const inflight = new Set<Promise<void>>();

  async function processUpdate(raw: unknown): Promise<void> {
    if (deps.logRawUpdates) log.debug({ raw }, 'webhook: сырое тело');

    const parsed = parseUpdate(raw);
    if (!parsed.ok) {
      // Детали — в тексте: часть хостингов показывает в логах только его. Значений полей здесь нет, только пути.
      if (parsed.reason === 'invalid') {
        log.warn(
          { update_type: parsed.updateType, issues: parsed.issues },
          `webhook: неожиданная форма события ${parsed.updateType} — ${parsed.issues.join('; ')}`,
        );
      } else {
        log.info({ update_type: parsed.updateType, reason: parsed.reason }, `webhook: событие ${parsed.updateType ?? '(без типа)'} пропущено (${parsed.reason})`);
      }
      return;
    }
    const ev = parsed.event;
    const ctx = { type: ev.type, userId: ev.userId, key: ev.dedupKey };

    if (!deps.limiter.allow(ev.userId)) {
      log.warn(ctx, 'webhook: превышен лимит запросов, событие отброшено');
      return;
    }

    if (!(await markProcessed(deps.db, ev.dedupKey))) {
      log.info(ctx, 'webhook: повторная доставка, пропускаем');
      return;
    }

    // Групповой чат (чат дома) — не диалог с ботом: chat_id группы нельзя запоминать как диалог
    // жильца (туда ушли бы напоминания), и пользователей из чужих сообщений не заводим.
    const isGroup = ev.type === 'added' || ev.type === 'removed' || (ev.chatType !== undefined && ev.chatType !== 'dialog');
    if (!isGroup) await deps.db.user.upsert({
      where: { maxUserId: ev.userId },
      create: { maxUserId: ev.userId, maxChatId: ev.chatId, name: ev.user.name, username: ev.user.username },
      update: {
        maxChatId: ev.chatId,
        lastSeenAt: new Date(),
        ...(ev.user.name ? { name: ev.user.name } : {}),
        ...(ev.user.username ? { username: ev.user.username } : {}),
      },
    });

    log.info(ctx, `webhook: событие принято — ${ev.type}, user ${ev.userId}, chat ${ev.chatId}`);
    await deps.route(ev);
    log.info(ctx, `webhook: событие обработано — ${ev.type}`);
  }

  /** Проверка секрета — ПЕРВОЙ, до разбора тела: чужой запрос не должен даже парситься. */
  const verify = (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('X-Max-Bot-Api-Secret');
    if (!secretMatches(incoming, deps.secret)) {
      // Значение секрета не логируем — только есть ли заголовок и какие заголовки пришли.
      const why = incoming
        ? `секрет не совпадает (длина ${incoming.length}, ожидается ${deps.secret.length})`
        : `заголовка X-Max-Bot-Api-Secret нет; заголовки: ${Object.keys(req.headers).join(', ')}`;
      log.warn({ ip: req.ip }, `webhook: неверный секрет — ${why}`);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  /** Битый JSON от подлинного отправителя: 200, чтобы MAX не ретраил заведомо сломанное событие. */
  const onBodyError = (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if ((err as { type?: string }).type === 'entity.parse.failed' || (err as { status?: number }).status === 400) {
      log.warn('webhook: тело не является корректным JSON');
      res.status(200).json({ ok: true });
      return;
    }
    next(err);
  };

  const handler = (req: Request, res: Response): void => {
    // Отвечаем немедленно: MAX ретраит при медленном ответе.
    res.status(200).json({ ok: true });

    const body: unknown = req.body;
    const p = processUpdate(body)
      .catch((err: unknown) => {
        const update_type = (body as { update_type?: unknown } | undefined)?.update_type;
        log.error({ update_type }, `webhook: ошибка обработки события ${String(update_type)} — ${describeError(err)}`);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  return {
    verify,
    onBodyError,
    handler,
    processUpdate,
    /** Дождаться незавершённых обработок (graceful shutdown). */
    drain: async (timeoutMs = 10_000) => {
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    },
  };
}
