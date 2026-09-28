import type { Logger } from 'pino';
import { describeError, type MaxClient } from './client.js';

export const UPDATE_TYPES = ['message_created', 'bot_started', 'message_callback', 'bot_added', 'bot_removed'];

export type SubscriptionResult = 'created' | 'existing';

/**
 * Создаёт (или обновляет) подписку на url и проверяет её через GET /subscriptions.
 * Повторный вызов безопасен: если MAX отклонил POST, но подписка на этот url уже есть,
 * считаем, что всё в порядке, и предупреждаем о возможном старом секрете.
 */
export async function ensureSubscription(
  max: MaxClient,
  url: string,
  secret: string,
  log: Logger,
): Promise<SubscriptionResult> {
  let result: SubscriptionResult = 'created';
  try {
    await max.subscribe(url, UPDATE_TYPES, secret);
  } catch (err) {
    const { subscriptions } = await max.listSubscriptions();
    if (!subscriptions.some((s) => s.url === url)) throw err;
    log.warn({ url }, 'MAX отклонил POST /subscriptions, но подписка на этот адрес уже есть. Если меняли MAX_WEBHOOK_SECRET — удалите подписку и создайте заново');
    result = 'existing';
  }

  const { subscriptions } = await max.listSubscriptions();
  if (!subscriptions.some((s) => s.url === url)) {
    throw new Error(`подписка на ${url} не появилась в GET /subscriptions`);
  }
  const others = subscriptions.filter((s) => s.url !== url).map((s) => s.url);
  if (others.length > 0) {
    log.warn({ others }, 'у бота есть подписки на другие адреса — события могут уходить туда');
  }
  return result;
}

/**
 * Автоподписка при старте (для хостинга без консоли). Домен хостинга может
 * начать принимать запросы не сразу после старта контейнера, поэтому повторяем.
 */
export async function autoSubscribe(
  max: MaxClient,
  publicBaseUrl: string,
  secret: string,
  log: Logger,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 20_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${publicBaseUrl.replace(/\/+$/, '')}/webhook`;

  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await ensureSubscription(max, url, secret, log);
      log.info({ url, result: r, update_types: UPDATE_TYPES }, 'MAX: подписка на вебхук активна');
      return true;
    } catch (err) {
      log.warn({ url, attempt: i, attempts }, `MAX: не удалось оформить подписку (попытка ${i}/${attempts}) — ${describeError(err)}`);
      if (i < attempts) await sleep(delayMs);
    }
  }
  log.error({ url }, 'MAX: подписка не оформлена. Проверьте, что PUBLIC_BASE_URL открывается в браузере и отдаёт /health');
  return false;
}
