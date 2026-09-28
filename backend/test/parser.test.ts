import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUpdate } from '../src/webhook/parser.js';
import { botStarted, clone, messageCallback, messageCreated } from './fixtures.js';

describe('parseUpdate', () => {
  it('message_created → message', () => {
    const r = parseUpdate(messageCreated);
    assert.ok(r.ok);
    assert.deepEqual(
      { ...r.event, attachments: undefined },
      {
        type: 'message',
        dedupKey: 'msg:mid.abc123',
        user: { userId: '1234567890', name: 'Иван Иванов', username: 'ivan_max' },
        userId: '1234567890',
        chatId: '1234567890',
        chatType: 'dialog',
        text: 'Течёт батарея',
        messageId: 'mid.abc123',
        attachments: undefined,
        timestamp: 1758654000000,
      },
    );
  });

  it('message_callback → callback, chat_id берётся из message.recipient', () => {
    const r = parseUpdate(messageCallback);
    assert.ok(r.ok);
    assert.equal(r.event.type, 'callback');
    assert.equal(r.event.dedupKey, 'cb:cb.xyz789');
    assert.equal(r.event.callbackId, 'cb.xyz789');
    assert.equal(r.event.payload, 'req:new:heating');
    assert.equal(r.event.chatId, '1234567890');
    assert.equal(r.event.userId, '1234567890');
  });

  it('message_callback без message — chat_id с верхнего уровня', () => {
    const u = { ...clone(messageCallback), message: undefined, chat_id: 555 };
    const r = parseUpdate(u);
    assert.ok(r.ok);
    assert.equal(r.event.chatId, '555');
  });

  it('bot_started → started с payload диплинка', () => {
    const r = parseUpdate(botStarted);
    assert.ok(r.ok);
    assert.equal(r.event.type, 'started');
    assert.equal(r.event.payload, 'house_001');
    assert.equal(r.event.chatId, '1234567890');
    assert.equal(r.event.dedupKey, 'start:1234567890:1573226679188');
  });

  it('bot_started без payload', () => {
    const u = clone(botStarted) as Record<string, unknown>;
    delete u.payload;
    const r = parseUpdate(u);
    assert.ok(r.ok);
    assert.equal(r.event.payload, undefined);
  });

  it('id строкой и лишние поля не ломают разбор', () => {
    const u = clone(messageCreated) as any;
    u.message.sender.user_id = '9007199254740993';
    u.message.extra_field = { x: 1 };
    const r = parseUpdate(u);
    assert.ok(r.ok);
    assert.equal(r.event.userId, '9007199254740993');
  });

  it('текст null → пустая строка (сообщение только с вложением)', () => {
    const u = clone(messageCreated) as any;
    u.message.body.text = null;
    u.message.body.attachments = [{ type: 'image', payload: { token: 't' } }];
    const r = parseUpdate(u);
    assert.ok(r.ok);
    assert.equal(r.event.text, '');
    assert.deepEqual(r.event.attachments, [{ type: 'image', payload: { token: 't' } }]);
  });

  it('bot_added / bot_removed в групповом чате → added / removed; канал — игнорируется', () => {
    const r = parseUpdate({ update_type: 'bot_added', timestamp: 5, chat_id: -100, user: { user_id: 7, name: 'Админ' }, is_channel: false });
    assert.ok(r.ok);
    assert.deepEqual([r.event.type, r.event.chatId, r.event.chatType, r.event.userId, r.event.dedupKey], ['added', '-100', 'chat', '7', 'added:-100:5']);
    const rm = parseUpdate({ update_type: 'bot_removed', timestamp: 6, chat_id: -100, user: { user_id: 7 } });
    assert.ok(rm.ok && rm.event.type === 'removed');
    assert.deepEqual(parseUpdate({ update_type: 'bot_added', timestamp: 5, chat_id: -1, user: { user_id: 7 }, is_channel: true }), { ok: false, reason: 'ignored', updateType: 'bot_added' });
  });

  it('ненужные типы игнорируются', () => {
    for (const t of ['message_edited', 'user_added', 'chat_title_changed']) {
      const r = parseUpdate({ update_type: t, timestamp: 1 });
      assert.deepEqual(r, { ok: false, reason: 'ignored', updateType: t });
    }
    assert.equal(parseUpdate(null).ok, false);
    assert.equal(parseUpdate('str').ok, false);
    assert.equal(parseUpdate({}).ok, false);
  });

  it('camelCase вместо snake_case → invalid с путями полей, без значений', () => {
    const r = parseUpdate({
      update_type: 'message_created',
      timestamp: 1,
      message: { sender: { userId: 1 }, recipient: { chatId: 1 }, body: { mid: 'm', text: 'секрет' } },
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason === 'invalid');
    if (!r.ok && r.reason === 'invalid') {
      assert.ok(r.issues.some((i) => i.startsWith('message.sender.user_id')));
      assert.ok(!r.issues.join(' ').includes('секрет'));
    }
  });

  it('сообщения от ботов пропускаются', () => {
    const u = clone(messageCreated) as any;
    u.message.sender.is_bot = true;
    const r = parseUpdate(u);
    assert.ok(!r.ok && r.reason === 'from_bot');
  });
});
