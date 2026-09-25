import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { createMaxIO } from '../src/bot/router.js';
import { MaxApiError } from '../src/max/client.js';
import { btn, inlineKeyboard } from '../src/max/keyboard.js';

const logger = pino({ level: 'silent' });
type Sent = { text: string; attachments?: Array<{ payload: { buttons: Array<Array<Record<string, unknown>>> } }> };

function fakeMax(rejectOpenApp: boolean) {
  const sent: Sent[] = [];
  const max = {
    async sendMessage(_to: unknown, body: Sent) {
      const hasOpenApp = JSON.stringify(body).includes('"open_app"');
      if (rejectOpenApp && hasOpenApp) throw new MaxApiError(400, 'POST', '/messages', '{"code":"proto.payload"}');
      sent.push(body);
      return {} as never;
    },
    async answerCallback() {
      return {} as never;
    },
  };
  return { max, sent };
}

const kb = () => [
  [btn.openApp('Открыть в приложении', { webApp: 't186_hakaton_max_bot', contactId: 42, payload: 'req_r1', fallbackUrl: 'https://x.ru/app/#t=c' })],
  [btn.callback('Мои заявки', 'menu:list')],
];

describe('кнопка мини-приложения', () => {
  it('open_app уходит в MAX без служебного fallbackUrl', () => {
    const b = inlineKeyboard(kb()).payload.buttons[0]![0]!;
    assert.deepEqual(b, { type: 'open_app', text: 'Открыть в приложении', web_app: 't186_hakaton_max_bot', contact_id: 42, payload: 'req_r1' });
  });

  it('MAX принял open_app — отправлено как есть', async () => {
    const f = fakeMax(false);
    await createMaxIO({ max: f.max as never, logger }).send('c1', 'текст', kb());
    assert.equal(f.sent[0]!.attachments![0]!.payload.buttons[0]![0]!.type, 'open_app');
  });

  it('MAX отклонил open_app — то же сообщение уходит со ссылкой, дальше сразу ссылкой', async () => {
    const f = fakeMax(true);
    const io = createMaxIO({ max: f.max as never, logger });
    await io.send('c1', 'первое', kb());
    await io.send('c1', 'второе', kb());
    assert.equal(f.sent.length, 2);
    for (const m of f.sent) {
      assert.deepEqual(m.attachments![0]!.payload.buttons[0]![0], { type: 'link', text: 'Открыть в приложении', url: 'https://x.ru/app/#t=c' });
    }
  });
});
