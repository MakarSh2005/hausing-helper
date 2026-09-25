/**
 * Регистрация вебхука в MAX (ТЗ 5.0.2). Запускается вручную при деплое, не в рантайме.
 *
 *   npm run subscribe        — подписать PUBLIC_BASE_URL/webhook
 *   npm run subscriptions    — показать активные подписки
 *   npm run unsubscribe      — удалить подписку на PUBLIC_BASE_URL/webhook
 *
 * Перед подпиской эндпоинт должен отвечать 200 по HTTPS с доверенным сертификатом:
 * скрипт сначала сам проверяет /health.
 */
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { MaxClient } from '../src/max/client.js';
import { ensureSubscription, UPDATE_TYPES } from '../src/max/subscription.js';
import { createMaxFetch } from '../src/max/tls.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger('warn', false);
  const max = new MaxClient({
    token: config.MAX_BOT_TOKEN,
    baseUrl: config.MAX_API_URL,
    logger,
    fetchImpl: createMaxFetch(config.MAX_CA_FILE, logger),
  });
  const mode = process.argv[2];

  if (mode === '--list') {
    const { subscriptions } = await max.listSubscriptions();
    if (subscriptions.length === 0) console.log('Активных подписок нет.');
    for (const s of subscriptions) console.log(`- ${s.url}  [${(s.update_types ?? []).join(', ') || 'все типы'}]`);
    return;
  }

  if (!config.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL не задан');
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error('PUBLIC_BASE_URL должен начинаться с https:// — MAX не принимает HTTP');
  const url = `${base}/webhook`;

  if (mode === '--delete') {
    await max.unsubscribe(url);
    console.log(`Подписка удалена: ${url}`);
    return;
  }

  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).catch((e: Error) => e);
  if (health instanceof Error || !health.ok) {
    throw new Error(`${base}/health недоступен (${health instanceof Error ? health.message : health.status}). Сначала задеплойте бэкенд.`);
  }

  const me = await max.getMe();
  console.log(`Бот: ${me.name}${me.username ? ` (@${me.username})` : ''}`);
  if (!config.MAX_WEBHOOK_SECRET) throw new Error('MAX_WEBHOOK_SECRET не задан');
  const result = await ensureSubscription(max, url, config.MAX_WEBHOOK_SECRET, logger);
  console.log(`Подписка ${result === 'created' ? 'создана' : 'уже была'}: ${url}\nТипы событий: ${UPDATE_TYPES.join(', ')}`);
  console.log('Проверка GET /subscriptions: подписка на месте.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
