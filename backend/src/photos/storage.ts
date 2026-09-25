import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

/**
 * Файлы фото заявок на постоянном диске: <DATA_DIR>/photos/<id>.<ext>.
 * Имя файла — id вложения из БД (uuid), поэтому путь не зависит от данных пользователя.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
export const CONTENT_TYPES: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));

export interface PhotoStorage {
  /** Скачать фото и сохранить; вернуть имя файла или null (ошибка записана в лог). */
  download(url: string, id: string): Promise<string | null>;
  /** Полный путь к сохранённому файлу или null, если его нет. */
  resolve(file: string): string | null;
}

export function createPhotoStorage(deps: { dir: string; fetchImpl?: typeof fetch; logger: Logger }): PhotoStorage {
  const dir = path.resolve(deps.dir, 'photos');
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.logger.child({ module: 'photos' });
  fs.mkdirSync(dir, { recursive: true });

  return {
    async download(url, id) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || !/^https:\/\//.test(url)) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow' });
        const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        const ext = TYPES[type];
        if (!res.ok || !ext) {
          log.warn(`фото: не скачано — HTTP ${res.status}, тип «${type || 'нет'}»`);
          return null;
        }
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > MAX_BYTES) {
          log.warn(`фото: слишком большое (${declared} байт)`);
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_BYTES) {
          log.warn(`фото: пустое или слишком большое (${buf.length} байт)`);
          return null;
        }
        const file = `${id}.${ext}`;
        const tmp = path.join(dir, `.${file}.tmp`);
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, path.join(dir, file));
        return file;
      } catch (err) {
        log.warn(`фото: ошибка скачивания — ${(err as Error).message}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    resolve(file) {
      if (!/^[A-Za-z0-9-]{1,64}\.(jpg|png|webp|heic)$/.test(file)) return null;
      const p = path.join(dir, file);
      return fs.existsSync(p) ? p : null;
    },
  };
}
