import crypto from 'node:crypto';

/**
 * Сессионный токен мини-приложения: JWT HS256, в payload только sub (user_id MAX), iat и exp (ТЗ 5.2.1).
 * Своя реализация на node:crypto вместо библиотеки: нужен один алгоритм, и так видно,
 * что alg фиксирован — подмена на «none» или RS256 невозможна.
 */

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

const sign = (data: string, secret: string) => crypto.createHmac('sha256', secret).update(data).digest();

export function issueSessionToken(sub: string, secret: string, ttlSec: number, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const body = b64url(JSON.stringify({ sub, iat, exp: iat + ttlSec }));
  return `${HEADER}.${body}.${b64url(sign(`${HEADER}.${body}`, secret))}`;
}

export function verifySessionToken(token: string, secret: string, nowMs = Date.now()): { sub: string } | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  if (header !== HEADER) return null;
  const expected = sign(`${header}.${body}`, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown };
    if (typeof p.sub !== 'string' || !p.sub || typeof p.exp !== 'number') return null;
    if (p.exp <= Math.floor(nowMs / 1000)) return null;
    return { sub: p.sub };
  } catch {
    return null;
  }
}

/**
 * Ключ подписи: SESSION_JWT_SECRET, а если не задан — производный от токена бота.
 * Производный ключ не раскрывает токен (HMAC) и меняется вместе с ним.
 */
export function sessionSecret(explicit: string | undefined, botToken: string): string {
  return explicit ?? crypto.createHmac('sha256', 'housing-helper/session-jwt').update(botToken).digest('hex');
}

/**
 * Ключ для ссылок входа из бота («Открыть в приложении»). Отдельный от ключа сессий:
 * код из ссылки нельзя использовать как сессионный токен и наоборот.
 */
export function linkSecret(sessionKey: string): string {
  return crypto.createHmac('sha256', sessionKey).update('housing-helper/app-link').digest('hex');
}

/** Срок жизни ссылки входа: сутки — кнопка в старом сообщении бота ещё работает. */
export const LINK_TTL_SEC = 86_400;
