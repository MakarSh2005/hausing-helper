/**
 * Сборка вложения inline_keyboard (ТЗ 5.0.3).
 * buttons — массив рядов, каждый ряд — массив кнопок.
 */

export type Button =
  | { type: 'callback'; text: string; payload: string; intent?: 'default' | 'positive' | 'negative' }
  | { type: 'link'; text: string; url: string }
  /**
   * Запуск мини-приложения внутри MAX. web_app — имя бота (не адрес приложения: адрес привязан
   * к боту на платформе MAX), contact_id — user_id бота, payload приходит в start_param.
   * fallbackUrl — только для нас: если MAX отклонит кнопку, отправим обычную ссылку. В API не уходит.
   */
  | { type: 'open_app'; text: string; web_app: string; contact_id?: number; payload?: string; fallbackUrl?: string }
  | { type: 'request_contact'; text: string }
  | { type: 'request_geo_location'; text: string; quick?: boolean };

export interface InlineKeyboardAttachment {
  type: 'inline_keyboard';
  payload: { buttons: Button[][] };
}

/** Лимит payload callback-кнопки (консервативно; сверить с документацией MAX). */
export const CALLBACK_PAYLOAD_MAX = 1024;

export const btn = {
  callback(text: string, payload: string, intent?: 'default' | 'positive' | 'negative'): Button {
    if (payload.length > CALLBACK_PAYLOAD_MAX) throw new RangeError('callback payload слишком длинный');
    return intent ? { type: 'callback', text, payload, intent } : { type: 'callback', text, payload };
  },
  link(text: string, url: string): Button {
    if (!/^https:\/\//.test(url)) throw new Error('link-кнопка: нужен https:// URL');
    return { type: 'link', text, url };
  },
  openApp(text: string, app: { webApp: string; contactId?: number; payload?: string; fallbackUrl?: string }): Button {
    return {
      type: 'open_app',
      text,
      web_app: app.webApp,
      ...(app.contactId !== undefined ? { contact_id: app.contactId } : {}),
      ...(app.payload ? { payload: app.payload } : {}),
      ...(app.fallbackUrl ? { fallbackUrl: app.fallbackUrl } : {}),
    };
  },
  contact(text: string): Button {
    return { type: 'request_contact', text };
  },
};

export function inlineKeyboard(rows: Button[][]): InlineKeyboardAttachment {
  // Служебное поле fallbackUrl в MAX не отправляем.
  const clean = rows
    .filter((r) => r.length > 0)
    .map((r) => r.map((b) => (b.type === 'open_app' ? (({ fallbackUrl: _f, ...rest }) => rest)(b) : b)));
  if (clean.length === 0) throw new Error('inlineKeyboard: пустая клавиатура');
  return { type: 'inline_keyboard', payload: { buttons: clean as Button[][] } };
}

/** Та же клавиатура, но кнопки мини-приложения заменены обычными ссылками (если MAX не принял open_app). */
export function withoutOpenApp(rows: Button[][]): Button[][] {
  return rows
    .map((r) =>
      r.flatMap((b): Button[] =>
        b.type !== 'open_app' ? [b] : b.fallbackUrl ? [{ type: 'link', text: b.text, url: b.fallbackUrl }] : [],
      ),
    )
    .filter((r) => r.length > 0);
}
