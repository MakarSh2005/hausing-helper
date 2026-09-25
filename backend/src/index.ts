import { createApp } from './app.js';
import { createApiRouter } from './api/router.js';
import { issueSessionToken, LINK_TTL_SEC, linkSecret, sessionSecret } from './auth/sessionToken.js';
import { createRouter } from './bot/router.js';
import { createPrismaStore } from './bot/store.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createLogger } from './logger.js';
import { describeError, MaxApiError, MaxClient } from './max/client.js';
import crypto from 'node:crypto';
import { startPoller, warnIfWebhookActive } from './max/poller.js';
import { autoSubscribe } from './max/subscription.js';
import { createMaxFetch } from './max/tls.js';
import { startDedupCleanup } from './webhook/dedup.js';
import { createWebhookHandler } from './webhook/handler.js';
import { SlidingWindowLimiter } from './webhook/rateLimit.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');

  // Падение процесса должно оставлять след в логах, а не выглядеть как тихий перезапуск.
  process.on('uncaughtException', (err) => {
    logger.fatal(`необработанное исключение — ${describeError(err)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.error(`необработанный отказ промиса — ${describeError(err)}`);
  });
  const db = createDb();
  const max = new MaxClient({
    token: config.MAX_BOT_TOKEN,
    baseUrl: config.MAX_API_URL,
    logger,
    fetchImpl: createMaxFetch(config.MAX_CA_FILE, logger),
  });

  // Проверка токена при старте (ТЗ 5.0.1). 401 — конфигурация сломана, в проде падаем.
  // Имя и ссылку бота отдаём на GET /bot — их не видно в логах хостингов, показывающих только текст.
  const botInfo: { name?: string; username?: string; link?: string; userId?: number } = {};
  try {
    const me = await max.getMe();
    botInfo.name = me.name;
    botInfo.username = me.username;
    if (Number.isSafeInteger(Number(me.user_id))) botInfo.userId = Number(me.user_id);
    botInfo.link = me.username ? `https://max.ru/${me.username}` : undefined;
    logger.info(
      { bot: me.username ?? me.name, is_bot: me.is_bot },
      `MAX: токен действителен, бот «${me.name}»${botInfo.link ? ` — ${botInfo.link}` : ''}`,
    );
  } catch (err) {
    if (err instanceof MaxApiError && err.status === 401) {
      logger.fatal('MAX: токен отклонён (401) — проверьте MAX_BOT_TOKEN');
      if (config.NODE_ENV === 'production') process.exit(1);
    } else {
      logger.warn(`MAX: не удалось проверить токен, продолжаем — ${describeError(err)}`);
    }
  }

  const limiter = new SlidingWindowLimiter(config.WEBHOOK_RATE_LIMIT_PER_MIN);
  const sweep = setInterval(() => limiter.sweep(), 60_000);
  sweep.unref();

  // В режиме polling секрет не задан — ставим случайный, чтобы /webhook отвечал только 401.
  const webhookSecret = config.MAX_WEBHOOK_SECRET ?? crypto.randomBytes(32).toString('hex');
  const sessionKey = sessionSecret(config.SESSION_JWT_SECRET, config.MAX_BOT_TOKEN);
  const appBase = config.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  const appLinkKey = linkSecret(sessionKey);
  const bot = createRouter({
    db, max, logger,
    options: {
      demoStatuses: config.MOCK_AUTO_STATUS_CHANGE,
      demoDueMinutes: config.DEMO_DUE_MINUTES,
      // Код входа — во фрагменте (#): он не уходит на сервер в строке запроса и не попадает в логи.
      appLink: appBase
        ? (userId, path = '') => `${appBase}/app/${path}#t=${issueSessionToken(userId, appLinkKey, LINK_TTL_SEC)}`
        : undefined,
      // Мини-приложение привязано к боту организаторами — открываем его кнопкой MAX (open_app).
      openApp: () =>
        config.MINIAPP_BUTTON === 'open_app' && botInfo.username
          ? { webApp: botInfo.username, ...(botInfo.userId !== undefined ? { contactId: botInfo.userId } : {}) }
          : undefined,
    },
  });
  const webhook = createWebhookHandler({
    secret: webhookSecret,
    db,
    logger,
    limiter,
    route: bot,
    logRawUpdates: config.LOG_RAW_UPDATES,
  });
  const stopCleanup = startDedupCleanup(db, logger);

  // Напоминания о просроченных заявках: раз в минуту, состояние — только в БД (переживает рестарт).
  let reminding = false;
  const reminders = setInterval(() => {
    if (reminding) return;
    reminding = true;
    bot
      .remindOverdue()
      .catch((err) => logger.error(`напоминания: ошибка — ${describeError(err)}`))
      .finally(() => (reminding = false));
  }, 60_000);
  reminders.unref();
  if (config.DEMO_DUE_MINUTES) logger.info(`демо-режим: напоминание о заявке через ${config.DEMO_DUE_MINUTES} мин после подачи`);

  const api = createApiRouter({
    store: createPrismaStore(db),
    logger,
    botToken: config.MAX_BOT_TOKEN,
    sessionSecret: sessionKey,
    sessionTtlSec: config.SESSION_TTL_SECONDS,
    demoStatuses: config.MOCK_AUTO_STATUS_CHANGE,
  });
  if (!config.SESSION_JWT_SECRET) logger.info('мини-приложение: ключ сессий производный от токена бота (SESSION_JWT_SECRET не задан)');
  const app = createApp({ db, logger, webhook, botInfo, api, webappDir: config.WEBAPP_DIR });
  let poller: ReturnType<typeof startPoller> | undefined;
  // 0.0.0.0 — явно IPv4: в части контейнерных сред прослушивание только :: недоступно снаружи.
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    logger.info({ port: config.PORT, mode: config.MAX_MODE }, `сервер запущен на порту ${config.PORT}, режим ${config.MAX_MODE}, память ${rssMb} МБ`);
    if (config.MAX_MODE === 'polling') {
      void warnIfWebhookActive(max, logger);
      poller = startPoller({ max, logger, processUpdate: webhook.processUpdate });
      return;
    }
    // MAX требует, чтобы адрес уже отвечал 200 — поэтому подписка только после listen.
    if (config.MAX_AUTO_SUBSCRIBE && config.PUBLIC_BASE_URL) {
      void autoSubscribe(max, config.PUBLIC_BASE_URL, webhookSecret, logger);
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'остановка');
    stopCleanup();
    clearInterval(reminders);
    await poller?.stop();
    server.close();
    await webhook.drain();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Конфиг ещё может быть не загружен — логгера нет; сообщение loadConfig не содержит значений.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
