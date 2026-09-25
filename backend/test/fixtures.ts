/** Примеры событий — дословно из ТЗ, раздел 5.0.4 и 5.1.2. */

export const messageCreated = {
  update_type: 'message_created',
  timestamp: 1758654000000,
  message: {
    sender: { user_id: 1234567890, name: 'Иван Иванов', username: 'ivan_max' },
    recipient: { chat_id: 1234567890, chat_type: 'dialog' },
    timestamp: 1758654000000,
    body: { mid: 'mid.abc123', seq: 42, text: 'Течёт батарея', attachments: [] },
  },
};

export const messageCallback = {
  update_type: 'message_callback',
  timestamp: 1758654050000,
  callback: {
    callback_id: 'cb.xyz789',
    payload: 'req:new:heating',
    user: { user_id: 1234567890, name: 'Иван Иванов' },
  },
  message: { recipient: { chat_id: 1234567890 }, body: { mid: 'mid.abc123' } },
};

export const botStarted = {
  update_type: 'bot_started',
  timestamp: 1573226679188,
  chat_id: 1234567890,
  user: { user_id: 1234567890, name: 'Иван', username: 'ivan_petrov' },
  payload: 'house_001',
};

export const clone = <T>(x: T): T => structuredClone(x);
