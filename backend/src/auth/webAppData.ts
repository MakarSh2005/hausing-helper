import crypto from 'node:crypto';

/**
 * Проверка стартовых данных мини-приложения MAX (ТЗ 5.2.1, этап 6).
 *
 * Алгоритм повторяет эталон из документации MAX (dev.max.ru/docs/webapps/validation):
 *  1. строка вида key1=value1&key2=value2 — это window.WebApp.initData;
 *  2. hash должен встретиться ровно один раз, его исключаем;
 *  3. значения — decodeURIComponent (не URLSearchParams: тот превращает «+» в пробел);
 *  4. сортировка по ключу через localeCompare, склейка «key=value» через \n;
 *  5. secret_key = HMAC-SHA256(key = "WebAppData", data = BOT_TOKEN);
 *  6. hash = hex(HMAC-SHA256(key = secret_key, data = строка из п. 4)).
 *
 * Расхождение с ТЗ: идентификатор пользователя MAX кладёт в user.id, а не в user.user_id.
 */

export interface WebAppUser {
  /** user_id MAX строкой — как в users.max_user_id. */
  userId: string;
  firstName?: string;
  lastName?: string;
  /** Публичный ник MAX, если задан. */
  username?: string;
  /** Фото профиля MAX (https). */
  photoUrl?: string;
  startParam?: string;
}

export type WebAppDataResult = { ok: true; user: WebAppUser } | { ok: false; reason: WebAppDataError };
export type WebAppDataError = 'malformed' | 'bad_hash' | 'expired' | 'no_user';

const MAX_LENGTH = 8192;

export function signWebAppData(pairs: Array<[string, string]>, botToken: string): string {
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = [...pairs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return crypto.createHmac('sha256', secret).update(check).digest('hex');
}

export function validateWebAppData(
  raw: string,
  botToken: string,
  opts: { nowMs?: number; maxAgeSec?: number } = {},
): WebAppDataResult {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const maxAge = opts.maxAgeSec ?? 86_400;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return { ok: false, reason: 'malformed' };

  const pairs: Array<[string, string]> = [];
  try {
    for (const part of raw.split('&')) {
      const i = part.indexOf('=');
      if (i <= 0) return { ok: false, reason: 'malformed' };
      pairs.push([part.slice(0, i), decodeURIComponent(part.slice(i + 1))]);
    }
  } catch {
    return { ok: false, reason: 'malformed' }; // битая %-последовательность
  }

  const keys = pairs.map(([k]) => k);
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'malformed' };
  const hash = pairs.find(([k]) => k === 'hash')?.[1];
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(signWebAppData(pairs.filter(([k]) => k !== 'hash'), botToken), 'hex');
  const got = Buffer.from(hash.toLowerCase(), 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_hash' };

  // Защита от повторного использования старых данных (ТЗ 5.2.1): окно 24 часа, из будущего — не более 5 минут.
  const authDate = Number(pairs.find(([k]) => k === 'auth_date')?.[1]);
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAge || authDate - nowSec > 300) return { ok: false, reason: 'expired' };

  const userRaw = pairs.find(([k]) => k === 'user')?.[1];
  if (!userRaw) return { ok: false, reason: 'no_user' };
  // id берём из текста, а не из JSON.parse: int64 не помещается в number без потерь.
  const id = /"(?:id|user_id)"\s*:\s*"?(\d{1,20})"?/.exec(userRaw)?.[1];
  if (!id) return { ok: false, reason: 'no_user' };
  let profile: Pick<WebAppUser, 'firstName' | 'lastName' | 'username' | 'photoUrl'>;
  try {
    const u = JSON.parse(userRaw) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const photo = str(u.photo_url, 1000);
    const raw = {
      firstName: str(u.first_name, 100),
      lastName: str(u.last_name, 100),
      username: str(u.username, 64),
      // Только https: адрес потом подставляется в <img> у соседей.
      photoUrl: photo && /^https:\/\/[^\s"'<>]+$/.test(photo) ? photo : undefined,
    };
    profile = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  } catch {
    return { ok: false, reason: 'no_user' };
  }
  const startParam = pairs.find(([k]) => k === 'start_param')?.[1];
  return { ok: true, user: { userId: id, ...profile, ...(startParam ? { startParam: startParam.slice(0, 128) } : {}) } };
}
