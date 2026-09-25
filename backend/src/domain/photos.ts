import type { ParsedAttachment } from '../webhook/parser.js';

/**
 * Фото к заявке. Из MAX приходит вложение type = "image" с payload { photo_id, token, url }
 * (формат сверен по открытым клиентам MAX Bot API; в ТЗ его нет). token позволяет отправить
 * то же фото снова, url — скачать. Надёжность url не документирована, поэтому при подаче
 * заявки фото сразу скачивается на постоянный диск.
 */

export const MAX_PHOTOS = 5;

export interface PhotoRef {
  token?: string;
  url?: string;
  photoId?: string;
}

/** Сохранённое фото заявки: file — имя файла на диске, если скачать удалось. */
export interface StoredPhoto extends PhotoRef {
  id: string;
  file?: string;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : typeof v === 'number' ? String(v) : undefined;

export function extractPhotos(attachments: ParsedAttachment[] | undefined): PhotoRef[] {
  const out: PhotoRef[] = [];
  for (const a of attachments ?? []) {
    if (a.type !== 'image' || !a.payload || typeof a.payload !== 'object') continue;
    const p = a.payload as Record<string, unknown>;
    const url = str(p.url, 4096);
    const ref: PhotoRef = {
      ...(str(p.token, 2048) ? { token: str(p.token, 2048) } : {}),
      ...(url && /^https:\/\//.test(url) ? { url } : {}),
      ...(str(p.photo_id, 64) ? { photoId: str(p.photo_id, 64) } : {}),
    };
    if (ref.token || ref.url) out.push(ref);
  }
  return out;
}

/** Есть ли во вложениях что-то, кроме фото (видео, файл, стикер) — чтобы честно сказать, что не принимаем. */
export const hasNonPhoto = (attachments: ParsedAttachment[] | undefined) =>
  (attachments ?? []).some((a) => a.type !== 'image' && a.type !== 'inline_keyboard');

export function encodeRef(p: PhotoRef & { file?: string }): string {
  return JSON.stringify({ token: p.token, url: p.url, photoId: p.photoId, file: p.file });
}

export function decodeRef(id: string, ref: string): StoredPhoto {
  try {
    const v = JSON.parse(ref) as Record<string, unknown>;
    return {
      id,
      ...(typeof v.token === 'string' ? { token: v.token } : {}),
      ...(typeof v.url === 'string' ? { url: v.url } : {}),
      ...(typeof v.photoId === 'string' ? { photoId: v.photoId } : {}),
      ...(typeof v.file === 'string' ? { file: v.file } : {}),
    };
  } catch {
    return { id };
  }
}
