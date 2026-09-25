import { pino, type Logger } from 'pino';

/**
 * Пути, которые никогда не попадают в логи (ТЗ 9.2): токен бота, секрет вебхука,
 * WebAppData, сессионные токены, лицевой счёт, номер квартиры.
 */
export const REDACT_PATHS = [
  'token',
  'secret',
  'authorization',
  'headers.authorization',
  'headers["x-max-bot-api-secret"]',
  'req.headers.authorization',
  'req.headers["x-max-bot-api-secret"]',
  'web_app_data',
  '*.web_app_data',
  'webAppData',
  'accountNumber',
  '*.accountNumber',
  'apartmentNumber',
  '*.apartmentNumber',
];

/** Маскирует токен бота, если он всё же оказался внутри строки (например, в тексте ошибки). */
export function maskSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 5) out = out.split(s).join('***');
  return out;
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '***' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
