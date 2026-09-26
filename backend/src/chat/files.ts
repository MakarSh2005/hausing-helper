import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sniffImage } from '../photos/storage.js';

/**
 * Вложения чата дома: фото, голосовые и файлы на постоянном диске — <DATA_DIR>/chat/<id>.<ext>.
 * Имя файла — id сообщения (uuid), поэтому путь не зависит от того, что прислал жилец.
 * Тип определяется по содержимому (сигнатуре), а не по заголовку клиента или расширению.
 */

export type ChatKind = 'photo' | 'voice' | 'file';

export const CHAT_LIMITS: Record<ChatKind, number> = {
  photo: 10 * 1024 * 1024,
  voice: 5 * 1024 * 1024,
  file: 20 * 1024 * 1024,
};
/** Голосовое — не длиннее 5 минут (клиент останавливает запись сам). */
export const MAX_VOICE_SEC = 300;

export interface DetectedFile {
  ext: string;
  /** Тип для ответа. Для документов — всегда скачивание, не показ в браузере. */
  mime: string;
  inline: boolean;
}

const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function sniffAudio(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  if (buf.toString('ascii', 0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf.toString('ascii', 0, 4) === '#!AM') return { ext: 'amr', mime: 'audio/amr' };
  return null;
}

/** Разрешённые документы: расширение → проверка сигнатуры. Исполняемые файлы и HTML не принимаются. */
const ZIP = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const OLE = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const PDF = (b: Buffer) => b.toString('ascii', 0, 5) === '%PDF-';
/** Простой текст: без нулевых байтов и не похож на HTML/SVG (их браузер мог бы исполнить). */
const TEXT = (b: Buffer) => {
  const head = b.subarray(0, 4096);
  if (head.includes(0)) return false;
  return !/^\s*<(?:!doctype|html|svg|script|\?xml)/i.test(head.toString('utf8'));
};
const DOCS: Record<string, (b: Buffer) => boolean> = {
  pdf: PDF,
  docx: ZIP, xlsx: ZIP, pptx: ZIP, odt: ZIP, ods: ZIP, odp: ZIP, zip: ZIP,
  doc: OLE, xls: OLE, ppt: OLE,
  txt: TEXT, csv: TEXT, rtf: (b) => b.toString('ascii', 0, 5) === '{\\rtf',
  jpg: (b) => sniffImage(b) === 'jpg', jpeg: (b) => sniffImage(b) === 'jpg', png: (b) => sniffImage(b) === 'png',
};
export const ALLOWED_DOCS = Object.keys(DOCS);

export function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

export function detectChatFile(kind: ChatKind, buf: Buffer, name: string): DetectedFile | null {
  if (buf.length === 0 || buf.length > CHAT_LIMITS[kind]) return null;
  if (kind === 'photo') {
    const ext = sniffImage(buf);
    return ext ? { ext, mime: IMAGE_MIME[ext]!, inline: true } : null;
  }
  if (kind === 'voice') {
    const a = sniffAudio(buf);
    return a ? { ...a, inline: true } : null;
  }
  const ext = extOf(name);
  const check = DOCS[ext];
  if (!check || !check(buf)) return null;
  return { ext: ext === 'jpeg' ? 'jpg' : ext, mime: 'application/octet-stream', inline: false };
}

/** Имя файла для показа и для Content-Disposition: без путей и управляющих символов. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const s = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim();
  return (s || 'файл').slice(0, 120);
}

export interface ChatFileStore {
  save(buf: Buffer, id: string, ext: string): Promise<string>;
  resolve(file: string): string | null;
  remove(file: string): Promise<void>;
}

const FILE_RE = /^[A-Za-z0-9-]{1,64}\.[a-z0-9]{1,5}$/;

export function createChatFileStore(dataDir: string): ChatFileStore {
  const dir = path.resolve(dataDir, 'chat');
  fs.mkdirSync(dir, { recursive: true });
  return {
    async save(buf, id, ext) {
      const file = `${id}.${ext}`;
      if (!FILE_RE.test(file)) throw new Error('bad file id');
      const tmp = path.join(dir, `.${file}.tmp`);
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, path.join(dir, file));
      return file;
    },
    resolve(file) {
      if (!FILE_RE.test(file)) return null;
      const p = path.join(dir, file);
      return fs.existsSync(p) ? p : null;
    },
    async remove(file) {
      if (!FILE_RE.test(file)) return;
      await fs.promises.rm(path.join(dir, file), { force: true });
    },
  };
}

// ─── подписанные ссылки ─────────────────────────────────────────────────────
// <img>, <audio> и открытие файла во внешнем браузере не передают заголовок Authorization,
// поэтому сервер выдаёт участникам чата ссылку с подписью: id сообщения + срок. Срок округлён
// до часа — в пределах часа ссылка одна и та же, и картинки не перезагружаются при опросе чата.

const HOUR = 3_600_000;

export function fileKey(sessionSecret: string): Buffer {
  return crypto.createHmac('sha256', sessionSecret).update('chat-files').digest();
}

export function signFile(key: Buffer, id: string, nowMs: number): string {
  const exp = (Math.floor(nowMs / HOUR) + 2) * HOUR;
  const sig = crypto.createHmac('sha256', key).update(`${id}.${exp}`).digest('base64url').slice(0, 32);
  return `${exp}.${sig}`;
}

export function verifyFile(key: Buffer, id: string, token: string, nowMs: number): boolean {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < nowMs) return false;
  const want = crypto.createHmac('sha256', key).update(`${id}.${exp}`).digest('base64url').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]!));
}
