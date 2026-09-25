import type { Logger } from 'pino';
import { describeError, MaxApiError, type MaxClient } from './client.js';
import { UPDATE_TYPES } from './subscription.js';

/**
 * Long polling (GET /updates) — режим для запуска на своём компьютере:
 * не нужны ни домен, ни HTTPS, ни подписка на вебхук.
 * Для production MAX рекомендует вебхук.
 *
 * Каждое событие проходит тот же конвейер, что и вебхук (processUpdate):
 * разбор → rate limit → идемпотентность → маршрутизация.
 */
export interface PollerOptions {
  max: MaxClient;
  logger: Logger;
  processUpdate: (raw: unknown) => Promise<void>;
  timeoutSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function startPoller(opts: PollerOptions) {
  const log = opts.logger.child({ module: 'poller' });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const controller = new AbortController();
  let marker: number | null = null;
  let failures = 0;

  const loop = async () => {
    log.info('long polling: жду сообщений боту');
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      try {
        const res = await opts.max.getUpdates(
          { marker, timeoutSec: opts.timeoutSec ?? 30, types: UPDATE_TYPES },
          controller.signal,
        );
        failures = 0;
        if (res.marker !== null && res.marker !== undefined) marker = res.marker;
        for (const raw of res.updates ?? []) {
          try {
            await opts.processUpdate(raw);
          } catch (err) {
            log.error(`long polling: ошибка обработки события — ${describeError(err)}`);
          }
        }
        // Лимит MAX — 2 запроса в секунду; пустой мгновенный ответ не должен превращаться в частый опрос.
        const elapsed = Date.now() - startedAt;
        if (elapsed < 500) await sleep(500 - elapsed);
      } catch (err) {
        if (controller.signal.aborted) break;
        if (err instanceof MaxApiError && err.status === 401) {
          log.fatal('long polling: токен отклонён (401) — проверьте MAX_BOT_TOKEN в .env');
          break;
        }
        failures++;
        const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
        log.warn({ waitMs }, `long polling: ошибка запроса, повтор через ${waitMs} мс — ${describeError(err)}`);
        await sleep(waitMs);
      }
    }
    log.info('long polling: остановлен');
  };

  const done = loop();
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
    done,
  };
}

/** Предупреждает, если у бота есть подписка на вебхук: при ней /updates событий не отдаёт. */
export async function warnIfWebhookActive(max: MaxClient, log: Logger): Promise<void> {
  try {
    const { subscriptions } = await max.listSubscriptions();
    if (subscriptions.length > 0) {
      log.warn(
        { urls: subscriptions.map((s) => s.url) },
        'у бота есть подписка на вебхук — в режиме polling сообщения не придут. Удалите её (npm run unsubscribe) или включите MAX_MODE=webhook',
      );
    }
  } catch (err) {
    log.debug({ err }, 'не удалось проверить подписки');
  }
}
