import { z } from 'zod';

/**
 * Единственное место, где читается process.env.
 * Секреты никогда не имеют значений по умолчанию — только из окружения (ТЗ 9.2, 9.3).
 */

const webhookSecret = z
  .string()
  // trim: пробел или перевод строки при копировании — самая частая ошибка
  .trim()
  .regex(/^[A-Za-z0-9-]{5,256}$/, 'MAX_WEBHOOK_SECRET: 5–256 символов, латиница, цифры и дефис');

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Логировать сырое тело вебхука — только для сверки формата на этапе 0. */
  LOG_RAW_UPDATES: bool,

  // trim: лишний пробел или \r из Блокнота Windows ломает авторизацию
  MAX_BOT_TOKEN: z.string().trim().min(10, 'MAX_BOT_TOKEN не задан'),
  /**
   * webhook — MAX присылает события на PUBLIC_BASE_URL/webhook (сервер с HTTPS).
   * polling — бот сам забирает события через GET /updates (запуск на своём компьютере).
   */
  MAX_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  /** Обязателен в режиме webhook. */
  MAX_WEBHOOK_SECRET: webhookSecret.optional(),
  MAX_API_URL: z.url().default('https://platform-api2.max.ru'),
  /** Сертификаты УЦ Минцифры для TLS к MAX (см. certs/README.md); none — отключить. */
  MAX_CA_FILE: z.string().optional(),
  MAX_APP_URL: z.url().optional(),
  /**
   * Как бот открывает мини-приложение: open_app — кнопкой MAX (нужна привязка адреса к боту
   * на платформе MAX), link — ссылкой со входом (откроется в браузере).
   */
  MINIAPP_BUTTON: z.enum(['open_app', 'link']).default('open_app'),
  /** Сборка мини-приложения, отдаётся по /app. */
  WEBAPP_DIR: z.string().default('webapp'),
  PUBLIC_BASE_URL: z.url().startsWith('https://', 'PUBLIC_BASE_URL должен начинаться с https://').optional(),
  /** Оформить подписку на вебхук при старте — для хостинга без консоли. */
  MAX_AUTO_SUBSCRIBE: bool,

  /** Ключ подписи сессий мини-приложения. Не задан — производится из MAX_BOT_TOKEN (см. auth/sessionToken.ts). */
  SESSION_JWT_SECRET: z.string().trim().min(32, 'SESSION_JWT_SECRET: не короче 32 символов').optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  DATABASE_URL: z.string().min(1),
  /** Постоянный диск: фото заявок лежат в <DATA_DIR>/photos. В Docker — /data. */
  DATA_DIR: z.string().default('./data'),

  MOCK_AUTO_STATUS_CHANGE: bool,
  /** Демо: напоминание о заявке через N минут вместо нормативного срока (сам срок в заявке не меняется). */
  DEMO_DUE_MINUTES: z.coerce.number().int().min(1).max(1440).optional(),
  DEMO_ADMIN_TOKEN: z.string().min(16).optional(),

  /** Лимит вебхука на одного user_id за минуту (ТЗ 9.2). */
  WEBHOOK_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(100),
});

export type Config = z.infer<typeof EnvSchema>;

const Refined = EnvSchema.refine((c) => c.MAX_MODE !== 'webhook' || !!c.MAX_WEBHOOK_SECRET, {
  path: ['MAX_WEBHOOK_SECRET'],
  message: 'нужен в режиме MAX_MODE=webhook (для запуска на своём компьютере поставьте MAX_MODE=polling)',
}).refine((c) => !c.MAX_AUTO_SUBSCRIBE || !!c.PUBLIC_BASE_URL, {
  path: ['PUBLIC_BASE_URL'],
  message: 'нужен при MAX_AUTO_SUBSCRIBE=true',
});

/** Пустые строки из .env трактуем как «не задано», иначе .optional() их не пропустит. */
function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Refined.safeParse(stripEmpty(env));
  if (!parsed.success) {
    // Печатаем только имена переменных и причину — значения не выводим.
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Некорректная конфигурация окружения:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
