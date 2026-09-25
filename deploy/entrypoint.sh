#!/bin/sh
# Старт контейнера «всё в одном»: права на /data → миграции → seed → бот.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# Запущены от root: отдаём папку данных appuser и перезапускаем себя без привилегий.
if [ "$(id -u)" = "0" ]; then
  chown -R appuser:appuser "$DATA_DIR" 2>/dev/null || true
  if su-exec appuser test -w "$DATA_DIR"; then
    exec su-exec appuser "$0" "$@"
  fi
  echo "WARN: $DATA_DIR недоступна для appuser — продолжаем от root" >&2
fi

echo "entrypoint: применяю миграции"
./node_modules/.bin/prisma migrate deploy

echo "entrypoint: заполняю справочники"
node dist/prisma/seed.js

echo "entrypoint: проверяю сеть до MAX"
node /usr/local/lib/netcheck.mjs || true

echo "entrypoint: запускаю бота"
exec node dist/src/index.js
