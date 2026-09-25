import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import type { Logger } from 'pino';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Сертификат platform-api2.max.ru выпущен УЦ Минцифры (Russian Trusted CA),
 * которого нет в стандартном наборе сертификатов Node.js (набор Mozilla).
 * Без него любой запрос к MAX падает с «fetch failed» ← UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
 *
 * Решение — добавить корневой и выпускающий сертификаты Минцифры К стандартным,
 * только для запросов к MAX. Проверка сертификатов остаётся включённой.
 * Файл: certs/russian_trusted_ca.pem (источник и отпечатки — в certs/README.md).
 *
 * NODE_EXTRA_CA_CERTS здесь не подходит: из --env-file Node его не читает.
 */

export const DEFAULT_CA_FILE = 'certs/russian_trusted_ca.pem';

/** 'none' — не добавлять сертификаты; иначе путь к PEM (относительно рабочей папки). */
export function resolveCaFile(setting: string | undefined): string | null {
  if (setting === 'none') return null;
  return path.resolve(process.cwd(), setting || DEFAULT_CA_FILE);
}

export function createMaxFetch(caSetting: string | undefined, log: Logger): typeof fetch {
  const file = resolveCaFile(caSetting);
  if (!file) {
    log.warn('MAX_CA_FILE=none — сертификаты Минцифры не подключены');
    return fetch;
  }
  let extra: string;
  try {
    extra = fs.readFileSync(file, 'utf8');
  } catch {
    log.warn(`файл сертификатов ${file} не найден — запросы к MAX могут не пройти проверку TLS`);
    return fetch;
  }
  const count = (extra.match(/BEGIN CERTIFICATE/g) ?? []).length;
  const agent = new Agent({ connect: { ca: [...tls.rootCertificates, extra] } });
  log.info(`TLS: подключены сертификаты Минцифры (${count} шт.) для запросов к MAX`);
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}
