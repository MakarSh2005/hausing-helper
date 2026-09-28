import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { describeError, MaxApiError, type MaxClient } from '../max/client.js';
import { inlineKeyboard, withoutOpenApp, type Button } from '../max/keyboard.js';
import { createBot, type Bot, type BotIO, type BotOptions } from './bot.js';
import { createPrismaStore } from './store.js';

/** Отправка сообщений и ответов на нажатия через MAX API. */
export function createMaxIO(deps: { max: Pick<MaxClient, 'sendMessage' | 'answerCallback'> & Partial<Pick<MaxClient, 'getChat' | 'getChatAdmins' | 'leaveChat'>>; logger: Logger }): BotIO {
  const log = deps.logger.child({ module: 'router' });

  // Если MAX однажды отклонил кнопку мини-приложения — дальше сразу шлём ссылку, без лишней ошибки.
  let openAppRejected = false;
  const hasOpenApp = (kb?: Button[][]) => !!kb?.some((r) => r.some((b) => b.type === 'open_app'));
  const post = (chatId: string, text: string, keyboard?: Button[][]) =>
    deps.max.sendMessage(
      { chatId },
      { text: text.slice(0, 4000), ...(keyboard?.length ? { attachments: [inlineKeyboard(keyboard)] } : {}) },
    );

  const io: BotIO = {
    async send(chatId: string, text: string, keyboard?: Button[][]) {
      if (!hasOpenApp(keyboard)) return void (await post(chatId, text, keyboard));
      if (openAppRejected) return void (await post(chatId, text, withoutOpenApp(keyboard!)));
      try {
        await post(chatId, text, keyboard);
      } catch (err) {
        if (!(err instanceof MaxApiError) || err.status < 400 || err.status >= 500) throw err;
        openAppRejected = true;
        log.warn(`router: MAX не принял кнопку мини-приложения (open_app), дальше — ссылкой — ${describeError(err)}`);
        await post(chatId, text, withoutOpenApp(keyboard!));
      }
    },
    async sendPhotos(chatId: string, text: string, tokens: string[]) {
      await deps.max.sendMessage(
        { chatId },
        { text: text.slice(0, 4000), attachments: tokens.slice(0, 10).map((token) => ({ type: 'image', payload: { token } })) },
      );
    },
    async chatInfo(chatId: string) {
      if (!deps.max.getChat) return { title: null, link: null, ownerId: null };
      const c = await deps.max.getChat(chatId);
      return { title: c.title ?? null, link: c.link ?? null, ownerId: c.owner_id != null ? String(c.owner_id) : null };
    },
    async chatAdmins(chatId: string) {
      if (!deps.max.getChatAdmins) return [];
      const r = await deps.max.getChatAdmins(chatId);
      return (r.members ?? []).map((m) => String(m.user_id));
    },
    async leaveChat(chatId: string) {
      await deps.max.leaveChat?.(chatId);
    },
    async answer(callbackId: string, notification: string) {
      try {
        await deps.max.answerCallback(callbackId, { notification });
      } catch (err) {
        log.warn(`router: MAX не принял ответ на нажатие — ${describeError(err)}`);
      }
    },
  };
  return io;
}

/** Связывает сценарии бота с MAX API и базой. */
export function createRouter(deps: { db: Db; max: MaxClient; logger: Logger; options?: BotOptions }): Bot {
  const io = createMaxIO(deps);
  return createBot({ store: createPrismaStore(deps.db), io, logger: deps.logger, options: deps.options });
}
