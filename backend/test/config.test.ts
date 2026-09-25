import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { houseKey } from '../src/domain/address.js';

const base = {
  MAX_BOT_TOKEN: 'token-0123456789',
  MAX_WEBHOOK_SECRET: 'abc-DEF-123',
  DATABASE_URL: 'file:/app/data/app.db',
};

describe('loadConfig', () => {
  it('минимальный набор + значения по умолчанию', () => {
    const c = loadConfig(base);
    assert.equal(c.PORT, 3000);
    assert.equal(c.MAX_API_URL, 'https://platform-api2.max.ru');
    assert.equal(c.MOCK_AUTO_STATUS_CHANGE, false);
    assert.equal(c.WEBHOOK_RATE_LIMIT_PER_MIN, 100);
  });

  it('пустые строки из .env.example = «не задано»', () => {
    const c = loadConfig({ ...base, SESSION_JWT_SECRET: '', DEMO_ADMIN_TOKEN: '', MAX_APP_URL: '' });
    assert.equal(c.SESSION_JWT_SECRET, undefined);
    assert.equal(c.MAX_APP_URL, undefined);
  });

  it('без токена — ошибка, в тексте нет значений секретов', () => {
    assert.throws(
      () => loadConfig({ ...base, MAX_BOT_TOKEN: '' }),
      (e: unknown) => e instanceof Error && e.message.includes('MAX_BOT_TOKEN') && !e.message.includes(base.MAX_WEBHOOK_SECRET),
    );
  });

  it('секрет вебхука: 5–256 символов, латиница, цифры, дефис', () => {
    for (const bad of ['abcd', 'has space', 'подчерк_', 'a_b_c_d', 'x'.repeat(257)]) {
      assert.throws(() => loadConfig({ ...base, MAX_WEBHOOK_SECRET: bad }), `должно отклонить: ${bad}`);
    }
    assert.doesNotThrow(() => loadConfig({ ...base, MAX_WEBHOOK_SECRET: 'a'.repeat(48) }));
  });
});

describe('houseKey', () => {
  it('разные написания одного адреса дают один ключ', () => {
    const k = houseKey('Казань', 'ул. Баумана', '15');
    assert.equal(houseKey('казань', 'Баумана', 'д. 15'), k);
    assert.equal(houseKey('Казань', 'улица Баумана', 'дом 15'), k);
  });
  it('корпус различается', () => {
    assert.notEqual(houseKey('Казань', 'пр-т Победы', '100', '2'), houseKey('Казань', 'пр-т Победы', '100'));
  });
});
