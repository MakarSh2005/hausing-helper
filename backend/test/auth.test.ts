import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issueSessionToken, sessionSecret, verifySessionToken } from '../src/auth/sessionToken.js';
import { signWebAppData, validateWebAppData } from '../src/auth/webAppData.js';

const TOKEN = 'test-bot-token-1234567890';
const NOW = Date.parse('2026-09-24T12:00:00Z');
const nowSec = Math.floor(NOW / 1000);

/** Пары как в примере из документации MAX; auth_date — «сейчас». */
function pairs(over: Record<string, string> = {}): Array<[string, string]> {
  const base: Record<string, string> = {
    chat: '{"id":12345,"type":"DIALOG"}',
    ip: '192.168.0.1',
    user: '{"id":67890,"first_name":"Max","last_name":"User","username":null,"language_code":"ru","photo_url":null}',
    query_id: '4c0ab423-342b-4e45-aea4-2747dbc500cd',
    auth_date: String(nowSec),
    ...over,
  };
  return Object.entries(base);
}
/** Строка как window.WebApp.initData: значения в URL-кодировке, hash в конце. */
function initData(p: Array<[string, string]>, hash = signWebAppData(p, TOKEN)): string {
  return [...p, ['hash', hash] as [string, string]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** Эталон из документации MAX (dev.max.ru/docs/webapps/validation), перенесён без изменений логики. */
async function referenceValidate(appData: string, botToken: string): Promise<boolean> {
  const params: string[][] = appData.split('&').map((x) => x.split('='));
  if (params.filter((x) => x[0] === 'hash').length !== 1) return false;
  const originalHash = params.find((x) => x[0] === 'hash');
  if (!originalHash || typeof originalHash[1] !== 'string') return false;
  for (const param of params) param[1] = decodeURIComponent(param[1]!);
  params.sort((a, b) => a[0]!.localeCompare(b[0]!));
  const launchParams = params.filter((x) => x[0] !== 'hash').map((x) => `${x[0]}=${x[1]}`).join('\n');
  const enc = new TextEncoder();
  const key = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']),
    enc.encode(botToken),
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']),
    enc.encode(launchParams),
  );
  const hash = Array.from(new Uint8Array(sig)).map((b) => ('00' + b.toString(16)).slice(-2)).join('');
  return hash === originalHash[1];
}

describe('WebAppData', () => {
  it('подпись совпадает с эталонной реализацией из документации MAX', async () => {
    const raw = initData(pairs({ start_param: 'kzn_0018' }));
    assert.equal(await referenceValidate(raw, TOKEN), true);
    assert.equal(await referenceValidate(raw, 'другой-токен-1234567890'), false);
  });

  it('валидные данные → user.id из поля id, имя и start_param', () => {
    const r = validateWebAppData(initData(pairs({ start_param: 'kzn_0018' })), TOKEN, { nowMs: NOW });
    assert.deepEqual(r, { ok: true, user: { userId: '67890', firstName: 'Max', startParam: 'kzn_0018' } });
  });

  it('id больше 2^53 не теряет точность', () => {
    const r = validateWebAppData(initData(pairs({ user: '{"id":12345678901234567890,"first_name":"A"}' })), TOKEN, { nowMs: NOW });
    assert.ok(r.ok && r.user.userId === '12345678901234567890');
  });

  it('«+» и не-ASCII в значениях — как у decodeURIComponent', () => {
    const raw = initData(pairs({ user: '{"id":1,"first_name":"Анна + Ко"}' }));
    const r = validateWebAppData(raw, TOKEN, { nowMs: NOW });
    assert.ok(r.ok && r.user.firstName === 'Анна + Ко');
  });

  it('подмена пользователя, чужой токен, неверный hash → bad_hash', () => {
    const good = initData(pairs());
    const forged = good.replace('67890', '11111');
    assert.deepEqual(validateWebAppData(forged, TOKEN, { nowMs: NOW }), { ok: false, reason: 'bad_hash' });
    assert.deepEqual(validateWebAppData(good, 'другой-токен-1234567890', { nowMs: NOW }), { ok: false, reason: 'bad_hash' });
    assert.deepEqual(validateWebAppData(initData(pairs(), '0'.repeat(64)), TOKEN, { nowMs: NOW }), { ok: false, reason: 'bad_hash' });
  });

  it('старше 24 часов или из будущего → expired', () => {
    const old = initData(pairs({ auth_date: String(nowSec - 86_401) }));
    const future = initData(pairs({ auth_date: String(nowSec + 3600) }));
    assert.deepEqual(validateWebAppData(old, TOKEN, { nowMs: NOW }), { ok: false, reason: 'expired' });
    assert.deepEqual(validateWebAppData(future, TOKEN, { nowMs: NOW }), { ok: false, reason: 'expired' });
  });

  it('мусор, два hash, битая %-последовательность → malformed; без user → no_user', () => {
    for (const raw of ['', 'abc', 'hash=zz', `${initData(pairs())}&hash=${'a'.repeat(64)}`, `user=%E0%A4%A&${initData(pairs())}`]) {
      assert.deepEqual(validateWebAppData(raw, TOKEN, { nowMs: NOW }), { ok: false, reason: 'malformed' }, raw.slice(0, 40));
    }
    const noUser = pairs().filter(([k]) => k !== 'user');
    assert.deepEqual(validateWebAppData(initData(noUser), TOKEN, { nowMs: NOW }), { ok: false, reason: 'no_user' });
  });
});

describe('сессионный токен', () => {
  const S = 'x'.repeat(40);
  it('выдача и проверка', () => {
    const t = issueSessionToken('67890', S, 3600, NOW);
    assert.deepEqual(verifySessionToken(t, S, NOW + 1000), { sub: '67890' });
  });
  it('истёк, чужой ключ, подмена payload, alg=none → null', () => {
    const t = issueSessionToken('67890', S, 3600, NOW);
    assert.equal(verifySessionToken(t, S, NOW + 3600_000), null);
    assert.equal(verifySessionToken(t, 'y'.repeat(40), NOW), null);
    const [h, , sig] = t.split('.');
    const body = Buffer.from(JSON.stringify({ sub: '1', iat: nowSec, exp: nowSec + 3600 })).toString('base64url');
    assert.equal(verifySessionToken(`${h}.${body}.${sig}`, S, NOW), null);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal(verifySessionToken(`${none}.${t.split('.')[1]}.`, S, NOW), null);
    assert.equal(verifySessionToken('abc', S, NOW), null);
  });
  it('производный ключ: стабилен и не равен токену', () => {
    assert.equal(sessionSecret(undefined, TOKEN), sessionSecret(undefined, TOKEN));
    assert.notEqual(sessionSecret(undefined, TOKEN), TOKEN);
    assert.equal(sessionSecret('explicit-secret-value-0123456789abcdef', TOKEN), 'explicit-secret-value-0123456789abcdef');
  });
});
