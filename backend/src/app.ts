import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Logger } from 'pino';
import type { Db } from './db.js';
import { describeError } from './max/client.js';

/**
 * Express-приложение. Вебхук монтируется первым (ТЗ 5.2.5). CORS не включаем вовсе:
 * мини-приложение отдаётся с этого же адреса по /app, а /api доступен только с него же.
 */
export function createApp(deps: {
  db: Db;
  logger: Logger;
  /** Публичные сведения о боте (имя и ссылка видны любому пользователю MAX). */
  botInfo?: { name?: string; username?: string; link?: string };
  webhook: {
    verify: (req: Request, res: Response, next: NextFunction) => void;
    onBodyError: (err: unknown, req: Request, res: Response, next: NextFunction) => void;
    handler: (req: Request, res: Response) => void;
  };
  /** API мини-приложения (/api). */
  api?: Router;
  /** Папка со сборкой мини-приложения (/app); нет папки — маршрут не монтируется. */
  webappDir?: string;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Корень отвечает 200: часть хостингов проверяет живость приложения запросом к «/».
  app.get('/', (_req, res) => {
    res.json({ service: 'housing-helper', status: 'ok' });
  });

  app.get('/bot', (_req, res) => {
    const b = deps.botInfo ?? {};
    if (!b.name && !b.username) {
      res.status(503).json({ error: 'bot_unknown', message: 'Бот ещё не проверил токен — см. логи' });
      return;
    }
    res.json({ name: b.name, username: b.username, link: b.link });
  });

  app.get('/health', async (_req, res) => {
    try {
      await deps.db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  // Проверка доступности адреса при регистрации подписки (ТЗ 5.0.2: «эндпоинт должен отвечать 200»).
  // Ничего не раскрывает и ничего не обрабатывает; события принимаются только POST с секретом.
  app.get('/webhook', (_req, res) => {
    res.json({ ok: true });
  });

  // Порядок: секрет → разбор JSON → обработчик. Ошибка разбора ловится только для этого маршрута.
  app.post(
    '/webhook',
    deps.webhook.verify,
    express.json({ limit: '1mb' }),
    deps.webhook.handler,
    deps.webhook.onBodyError,
  );

  if (deps.api) app.use('/api', deps.api);

  const webappDir = deps.webappDir && path.resolve(deps.webappDir);
  const hasWebapp = !!webappDir && fs.existsSync(path.join(webappDir, 'index.html'));
  if (webappDir) {
    if (hasWebapp) deps.logger.info('мини-приложение: раздаётся по /app');
    else deps.logger.warn(`мини-приложение: сборка не найдена в ${webappDir} — /app не работает`);
  }
  if (webappDir && hasWebapp) {
    const index = path.join(webappDir, 'index.html');
    app.use('/app', (_req, res, next) => {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'no-referrer');
      next();
    });
    // Файлы сборки с хешем в имени кешируются надолго, index.html — нет (иначе не увидеть обновление).
    app.use('/app', express.static(webappDir, { index: false, maxAge: '7d', immutable: true }));
    app.get(['/app', '/app/{*rest}'], (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Маршрут не найден' });
  });

  // Единый формат ошибок. Битый JSON в /webhook сюда тоже попадает.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) deps.logger.error({ path: req.path }, `необработанная ошибка ${req.method} ${req.path} — ${describeError(err)}`);
    else deps.logger.warn({ path: req.path, status }, 'ошибка запроса');
    res.status(status).json({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Внутренняя ошибка' : 'Некорректный запрос',
    });
  });

  return app;
}
