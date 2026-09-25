# Сертификаты УЦ Минцифры для MAX API

`russian_trusted_ca.pem` — корневой (Russian Trusted Root CA) и выпускающий (Russian Trusted Sub CA) сертификаты Минцифры России.

**Зачем.** Сертификат `platform-api2.max.ru` выпущен этим УЦ, а в стандартном наборе Node.js (набор Mozilla) его нет. Без этого файла любой запрос к MAX падает с `fetch failed` ← `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

**Как используется.** Сертификаты добавляются к стандартным только для запросов к MAX (`src/max/tls.ts`). Проверка TLS остаётся включённой. Сертификаты передаются только в запросы к MAX, общий список доверенных сертификатов процесса (`NODE_EXTRA_CA_CERTS`) не меняется. Путь можно переопределить через `MAX_CA_FILE`, отключить — `MAX_CA_FILE=none`.

## Источник и проверка

Официальный источник — CDN Госуслуг:
- https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
- https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt

Взято из репозитория `koenrh/russian-trusted-root-ca` и проверено криптографически: самоподпись корневого сертификата верна, выпускающий подписан ключом корневого. Выпускающий сертификат побайтно совпадает с копией из `FullDozzer/inkmaxbot`.

**Внимание:** копия корневого сертификата в `FullDozzer/inkmaxbot` повреждена: в ней `pathlen:0` вместо `pathlen:4`, а самоподпись не сходится. С ней MAX отвечает ошибкой `PATH_LENGTH_EXCEEDED`. Тест `test/tls.test.ts` проверяет подписи, чтобы такая подмена не прошла незаметно.

| Сертификат | Действует до | Отпечаток |
|---|---|---|
| Russian Trusted Root CA | 2032-02-27 | SHA-256: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`; SHA-256 ключа (SPKI): `02b8220c070728db771d9ac59e54521c4eddad21a783bb26cfdf19c1db0fae37` |
| Russian Trusted Sub CA | 2027-03-06 | SHA-256: `BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B` |

Проверка:

```bash
openssl crl2pkcs7 -nocrl -certfile certs/russian_trusted_ca.pem | openssl pkcs7 -print_certs -noout
npm test   # в том числе проверка подписей сертификатов
```

**Срок.** Выпускающий сертификат истекает 06.03.2027 — к тому времени обновите файл из источника выше.
