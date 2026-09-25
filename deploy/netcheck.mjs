// Диагностика сети при старте контейнера: DNS и HTTPS до MAX API.
// Токен не отправляется — любой HTTP-ответ (401, 403, 404) значит, что сеть и TLS в порядке.
// Сертификаты Минцифры добавляются только к этому запросу, как и в самом боте.
// Никогда не роняет запуск: только пишет в лог.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';

const host = new URL(process.env.MAX_API_URL || 'https://platform-api2.max.ru').host;
const caFile = process.env.MAX_CA_FILE && process.env.MAX_CA_FILE !== 'none'
  ? process.env.MAX_CA_FILE
  : '/app/certs/russian_trusted_ca.pem';

function describe(err) {
  const parts = [];
  let cur = err;
  for (let i = 0; cur && i < 4; i++) {
    parts.push(`${cur.name || 'Error'}: ${cur.message}${cur.code ? ` [${cur.code}]` : ''}`);
    cur = cur.cause;
  }
  return parts.join(' ← ');
}

function get(ca) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path: '/me', timeout: 8000, ...(ca ? { ca } : {}) }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout 8s'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

try {
  const addrs = await dns.lookup(host, { all: true });
  console.log(`netcheck: DNS ${host} → ${addrs.map((a) => a.address).join(', ')}`);
} catch (err) {
  console.log(`netcheck: DNS ошибка для ${host} — ${describe(err)}`);
}

let extra = null;
try {
  extra = fs.readFileSync(caFile, 'utf8');
} catch {
  console.log(`netcheck: файл сертификатов ${caFile} не найден`);
}

for (const [label, ca] of [
  ['только стандартные сертификаты', null],
  ['с сертификатами Минцифры', extra ? [...tls.rootCertificates, extra] : null],
]) {
  if (label !== 'только стандартные сертификаты' && !ca) continue;
  try {
    const status = await get(ca);
    console.log(`netcheck: HTTPS до ${host} (${label}) работает, ответ ${status}`);
  } catch (err) {
    console.log(`netcheck: HTTPS до ${host} (${label}) не проходит — ${describe(err)}`);
  }
}
