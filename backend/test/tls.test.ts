import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { createMaxFetch, resolveCaFile } from '../src/max/tls.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
const log = pino({ level: 'silent' });

describe('TLS: дополнительные сертификаты для MAX', () => {
  let server: https.Server;
  let url: string;

  before(async () => {
    server = https.createServer(
      { key: fs.readFileSync(path.join(dir, 'server.key')), cert: fs.readFileSync(path.join(dir, 'server.crt')) },
      (_req, res) => res.end('ok'),
    );
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    url = `https://localhost:${(server.address() as AddressInfo).port}/`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('без файла сертификатов сервер с неизвестным УЦ отклоняется', async () => {
    const f = createMaxFetch(path.join(dir, 'нет-такого-файла.pem'), log);
    await assert.rejects(f(url), (e: unknown) => /fetch failed/.test(String(e)));
  });

  it('с файлом УЦ (с комментариями в PEM) запрос проходит, проверка TLS не отключена', async () => {
    const f = createMaxFetch(path.join(dir, 'ca.pem'), log);
    const res = await f(url);
    assert.equal(await res.text(), 'ok');
  });

  it('сертификаты Минцифры: 2 шт., подписи верны, цепочка сходится', () => {
    const pem = fs.readFileSync(resolveCaFile(undefined)!, 'utf8');
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    assert.equal(blocks.length, 2);
    const [root, sub] = blocks.map((b) => new X509Certificate(b)) as [X509Certificate, X509Certificate];
    assert.match(root.subject, /CN=Russian Trusted Root CA/);
    assert.match(sub.subject, /CN=Russian Trusted Sub CA/);
    // Самоподпись корня: подменённое ограничение pathlen её ломает (так было с копией из inkmaxbot)
    assert.ok(root.verify(root.publicKey), 'самоподпись корневого сертификата не сходится');
    assert.ok(sub.checkIssued(root) && sub.verify(root.publicKey), 'выпускающий не подписан корневым');
    assert.equal(
      root.fingerprint256,
      'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31',
    );
  });

  it('MAX_CA_FILE=none отключает добавление', () => {
    assert.equal(resolveCaFile('none'), null);
    assert.equal(createMaxFetch('none', log), fetch);
  });
});
