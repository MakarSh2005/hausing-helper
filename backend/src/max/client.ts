import type { Logger } from 'pino';
import { maskSecrets } from '../logger.js';

/**
 * Клиент MAX Bot API (ТЗ 5.0).
 * - Authorization: <токен> — без префикса Bearer.
 * - Таймаут 5 с на каждую попытку.
 * - Ретраи: сетевые ошибки, таймаут, 429, 5xx. Прочие 4xx не ретраим — повтор не поможет.
 * - Не чаще 2 сообщений в секунду в один чат: отправки в один chat_id выстраиваются в очередь.
 */

export const MAX_TEXT_LENGTH = 4000;

export class MaxApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: string,
  ) {
    super(`MAX API ${method} ${path} → ${status}: ${responseBody.slice(0, 300)}`);
    this.name = 'MaxApiError';
  }
}

export type Recipient = { chatId: string } | { userId: string };

export interface NewMessageBody {
  text?: string;
  attachments?: unknown[];
  format?: 'markdown' | 'html';
  notify?: boolean;
  disable_link_preview?: boolean;
}

export interface CallbackAnswer {
  /** Заменить исходное сообщение (например, убрать кнопки). */
  message?: NewMessageBody;
  /** Короткое всплывающее уведомление пользователю. */
  notification?: string;
}

export interface BotInfo {
  user_id: number | string;
  name: string;
  username?: string;
  is_bot: boolean;
}

export interface MaxClientOptions {
  token: string;
  baseUrl: string;
  logger: Logger;
  timeoutMs?: number;
  retries?: number;
  /** Минимальный интервал между сообщениями в один чат (лимит 2 msg/s). */
  perChatIntervalMs?: number;
  /** Для тестов. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MaxClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly perChatIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Хвост очереди отправки для каждого чата. */
  private readonly chatQueues = new Map<string, Promise<unknown>>();

  constructor(opts: MaxClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.log = opts.logger.child({ module: 'max-client' });
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.retries = opts.retries ?? 3;
    this.perChatIntervalMs = opts.perChatIntervalMs ?? 550;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  getMe(): Promise<BotInfo> {
    return this.request<BotInfo>('GET', '/me');
  }

  /** POST /messages?chat_id=… | ?user_id=… */
  sendMessage(to: Recipient, body: NewMessageBody): Promise<unknown> {
    if (body.text && body.text.length > MAX_TEXT_LENGTH) {
      throw new RangeError(`Текст ${body.text.length} символов, лимит MAX — ${MAX_TEXT_LENGTH}`);
    }
    const query: Record<string, string> = 'chatId' in to ? { chat_id: to.chatId } : { user_id: to.userId };
    const queueKey = 'chatId' in to ? `c:${to.chatId}` : `u:${to.userId}`;
    return this.enqueue(queueKey, () => this.request('POST', '/messages', { query, body }));
  }

  /** GET /chats/{chatId} — групповой чат: название, владелец, ссылка-приглашение. */
  getChat(chatId: string): Promise<{ chat_id: number; type: string; title?: string | null; link?: string | null; owner_id?: number | null }> {
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}`);
  }

  /** GET /chats/{chatId}/members/admins — администраторы (бот должен быть участником). */
  getChatAdmins(chatId: string): Promise<{ members: Array<{ user_id: number | string }> }> {
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/members/admins`);
  }

  /** DELETE /chats/{chatId}/members/me — бот выходит из чата. */
  leaveChat(chatId: string): Promise<unknown> {
    return this.request('DELETE', `/chats/${encodeURIComponent(chatId)}/members/me`);
  }

  /** POST /answers?callback_id=… — ответ на нажатие inline-кнопки. */
  async answerCallback(callbackId: string, answer: CallbackAnswer): Promise<unknown> {
    const res = await this.request('POST', '/answers', { query: { callback_id: callbackId }, body: answer });
    assertSimpleSuccess(res, 'POST /answers');
    return res;
  }

  listSubscriptions(): Promise<{ subscriptions: Array<{ url: string; update_types?: string[]; time?: number }> }> {
    return this.request('GET', '/subscriptions');
  }

  subscribe(url: string, updateTypes: string[], secret: string): Promise<unknown> {
    return this.request('POST', '/subscriptions', { body: { url, update_types: updateTypes, secret } });
  }

  unsubscribe(url: string): Promise<unknown> {
    return this.request('DELETE', '/subscriptions', { query: { url } });
  }

  /**
   * GET /updates — long polling (только для локальной разработки).
   * Без marker MAX отдаёт лишь последнее событие, поэтому marker из ответа
   * нужно передавать в следующий запрос.
   */
  getUpdates(
    params: { marker?: number | null; timeoutSec?: number; limit?: number; types?: string[] },
    signal?: AbortSignal,
  ): Promise<{ updates: unknown[]; marker: number | null }> {
    const timeoutSec = params.timeoutSec ?? 30;
    const query: Record<string, string> = { timeout: String(timeoutSec), limit: String(params.limit ?? 100) };
    if (params.marker !== undefined && params.marker !== null) query.marker = String(params.marker);
    if (params.types?.length) query.types = params.types.join(',');
    // Соединение висит до timeoutSec — даём запас 10 с. Ретраи делает сам цикл опроса.
    return this.request('GET', '/updates', { query, timeoutMs: (timeoutSec + 10) * 1000, retries: 1, signal });
  }

  // ─── внутреннее ────────────────────────────────────────────────────────────

  /** Последовательная отправка в один чат с паузой между сообщениями. */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    const tail = run
      .catch(() => undefined)
      .then(() => this.sleep(this.perChatIntervalMs));
    this.chatQueues.set(key, tail);
    void tail.then(() => {
      if (this.chatQueues.get(key) === tail) this.chatQueues.delete(key);
    });
    return run;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string>;
      body?: unknown;
      /** Переопределить таймаут попытки (long polling держит соединение до 90 с). */
      timeoutMs?: number;
      retries?: number;
      /** Внешняя отмена (остановка процесса). */
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const retries = opts.retries ?? this.retries;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
      const isLast = attempt === retries - 1;
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.token,
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // Сетевая ошибка или таймаут — ретраим.
        lastError = err;
        // Причина — прямо в тексте сообщения: некоторые хостинги показывают в логах только его.
        this.log.warn({ method, path, attempt }, `MAX API: сетевая ошибка ${method} ${path} — ${this.safeErr(err)}`);
        if (!isLast) await this.sleep(2 ** attempt * 1000);
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }

      const bodyText = maskSecrets(await res.text().catch(() => ''), [this.token]);
      lastError = new MaxApiError(res.status, method, path, bodyText);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1);
        this.log.warn({ method, path, attempt, waitMs }, 'MAX API: 429, ждём');
        if (!isLast) await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500) {
        this.log.warn({ method, path, attempt, status: res.status }, 'MAX API: 5xx, повтор');
        if (!isLast) await this.sleep(2 ** attempt * 1000);
        continue;
      }
      // 4xx кроме 429 — ошибка запроса, повтор бессмысленен.
      throw lastError;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private safeErr(err: unknown): string {
    return maskSecrets(describeError(err), [this.token]);
  }
}

/**
 * Часть методов MAX (например, /answers) отвечает 200 с телом {"success": false, "message": "…"}.
 * HTTP-код такой отказ не показывает — проверяем тело.
 */
export function assertSimpleSuccess(res: unknown, what: string): void {
  if (res && typeof res === 'object' && (res as { success?: unknown }).success === false) {
    const msg = String((res as { message?: unknown }).message ?? 'без пояснения');
    throw new Error(`MAX API ${what}: success=false — ${msg}`);
  }
}

/**
 * «fetch failed» ничего не объясняет — настоящая причина лежит в err.cause
 * (ENOTFOUND — DNS, ECONNREFUSED/ENETUNREACH — сеть, UNABLE_TO_GET_ISSUER_CERT… — сертификат).
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      parts.push(`${cur.name}: ${cur.message}${typeof code === 'string' ? ` [${code}]` : ''}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(' ← ');
}
