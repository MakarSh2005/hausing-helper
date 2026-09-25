import { z } from 'zod';

/**
 * Разбор Update от MAX → ParsedEvent (ТЗ 5.1.2–5.1.3).
 * Единственное место, которое знает форму payload. Если реальный формат отличается
 * от документации (snake_case ↔ camelCase), правится только этот файл.
 *
 * Схемы нестрогие (лишние поля пропускаются): MAX добавляет поля, и из-за этого
 * бот не должен падать. Строго проверяются только поля, без которых событие не обработать.
 */

/** int64 может прийти числом или строкой — храним строкой. */
const Id = z.union([z.number().int(), z.string().min(1)]).transform(String);

const UserSchema = z.object({
  user_id: Id,
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().nullish(),
  is_bot: z.boolean().optional(),
});

const AttachmentSchema = z
  .object({ type: z.string(), payload: z.unknown().optional() })
  .loose();

const MessageCreatedSchema = z.object({
  update_type: z.literal('message_created'),
  timestamp: z.number(),
  message: z.object({
    sender: UserSchema,
    recipient: z.object({ chat_id: Id, chat_type: z.string().optional() }),
    body: z.object({
      mid: z.string().min(1),
      seq: z.number().optional(),
      text: z.string().nullish(),
      attachments: z.array(AttachmentSchema).nullish(),
    }),
  }),
});

const BotStartedSchema = z.object({
  update_type: z.literal('bot_started'),
  timestamp: z.number(),
  chat_id: Id,
  user: UserSchema,
  payload: z.string().max(128).nullish(),
});

const MessageCallbackSchema = z.object({
  update_type: z.literal('message_callback'),
  timestamp: z.number(),
  chat_id: Id.optional(),
  callback: z.object({
    callback_id: z.string().min(1),
    payload: z.string().nullish(),
    user: UserSchema,
  }),
  message: z
    .object({
      recipient: z.object({ chat_id: Id }).optional(),
      body: z.object({ mid: z.string() }).loose().optional(),
    })
    .nullish(),
});

export type EventType = 'message' | 'started' | 'callback';

export interface ParsedUser {
  userId: string;
  name?: string;
  username?: string;
}

export interface ParsedAttachment {
  type: string;
  payload?: unknown;
}

export interface ParsedEvent {
  type: EventType;
  /** Ключ идемпотентности для processed_updates. */
  dedupKey: string;
  user: ParsedUser;
  /** Для совместимости с кодом из ТЗ: то же, что user.userId. */
  userId: string;
  chatId: string;
  chatType?: string;
  text?: string;
  /** deep-link payload (bot_started) или payload кнопки (message_callback). */
  payload?: string;
  callbackId?: string;
  /** mid сообщения: для message — входящее, для callback — сообщение с кнопкой. */
  messageId?: string;
  attachments?: ParsedAttachment[];
  /** Unix ms. */
  timestamp: number;
}

export type ParseResult =
  | { ok: true; event: ParsedEvent }
  /** Тип события нам не нужен (bot_added, message_edited…) — игнорируем молча. */
  | { ok: false; reason: 'ignored'; updateType: string | undefined }
  /** Тип нужный, но форма не совпала с ожидаемой — это повод посмотреть логи. */
  | { ok: false; reason: 'invalid'; updateType: string; issues: string[] }
  /** Сообщение от бота (в т.ч. нашего собственного) — не обрабатываем. */
  | { ok: false; reason: 'from_bot'; updateType: string };

function toUser(u: z.infer<typeof UserSchema>): ParsedUser {
  const name = u.name ?? ([u.first_name, u.last_name].filter(Boolean).join(' ') || undefined);
  return { userId: u.user_id, name, username: u.username ?? undefined };
}

function issuesOf(err: z.ZodError): string[] {
  // Только пути и коды — без значений, чтобы в логи не попал текст пользователя.
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`);
}

export function parseUpdate(raw: unknown): ParseResult {
  const updateType =
    typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).update_type === 'string'
      ? ((raw as Record<string, unknown>).update_type as string)
      : undefined;

  switch (updateType) {
    case 'message_created': {
      const r = MessageCreatedSchema.safeParse(raw);
      if (!r.success) return { ok: false, reason: 'invalid', updateType, issues: issuesOf(r.error) };
      const u = r.data;
      if (u.message.sender.is_bot) return { ok: false, reason: 'from_bot', updateType };
      const user = toUser(u.message.sender);
      return {
        ok: true,
        event: {
          type: 'message',
          dedupKey: `msg:${u.message.body.mid}`,
          user,
          userId: user.userId,
          chatId: u.message.recipient.chat_id,
          chatType: u.message.recipient.chat_type,
          text: u.message.body.text ?? '',
          messageId: u.message.body.mid,
          attachments: (u.message.body.attachments ?? []).map((a) => ({ type: a.type, payload: a.payload })),
          timestamp: u.timestamp,
        },
      };
    }

    case 'bot_started': {
      const r = BotStartedSchema.safeParse(raw);
      if (!r.success) return { ok: false, reason: 'invalid', updateType, issues: issuesOf(r.error) };
      const u = r.data;
      const user = toUser(u.user);
      return {
        ok: true,
        event: {
          type: 'started',
          // У bot_started нет mid — ретрай той же доставки несёт тот же timestamp.
          dedupKey: `start:${user.userId}:${u.timestamp}`,
          user,
          userId: user.userId,
          chatId: u.chat_id,
          payload: u.payload ?? undefined,
          timestamp: u.timestamp,
        },
      };
    }

    case 'message_callback': {
      const r = MessageCallbackSchema.safeParse(raw);
      if (!r.success) return { ok: false, reason: 'invalid', updateType, issues: issuesOf(r.error) };
      const u = r.data;
      const chatId = u.message?.recipient?.chat_id ?? u.chat_id;
      if (!chatId) return { ok: false, reason: 'invalid', updateType, issues: ['chat_id: missing'] };
      const user = toUser(u.callback.user);
      return {
        ok: true,
        event: {
          type: 'callback',
          dedupKey: `cb:${u.callback.callback_id}`,
          user,
          userId: user.userId,
          chatId,
          payload: u.callback.payload ?? undefined,
          callbackId: u.callback.callback_id,
          messageId: u.message?.body?.mid,
          timestamp: u.timestamp,
        },
      };
    }

    default:
      return { ok: false, reason: 'ignored', updateType };
  }
}
