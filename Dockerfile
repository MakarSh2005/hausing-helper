# Образ «всё в одном контейнере» для хостинга без docker compose (Amvera и аналоги).
# Для локального запуска используйте compose.yaml — там миграции вынесены в отдельный сервис.
#
# При старте: миграции → seed → бот. База — в /data (постоянное хранилище хостинга).
# Мини-приложение собирается здесь же и раздаётся бэкендом по /app.
# Контекст сборки — корень репозитория.

# ── мини-приложение (React + Vite + MAX UI) ──
FROM node:20-alpine AS webapp
WORKDIR /w
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY webapp/index.html webapp/vite.config.ts webapp/tsconfig.json ./
COPY webapp/src ./src
RUN npm run build

# ── бэкенд ──
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/prisma ./prisma
RUN npx prisma generate
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# su-exec — чтобы стартовать от root только ради прав на /data и сразу сбросить привилегии
RUN apk add --no-cache openssl su-exec \
 && addgroup -S -g 10001 appuser && adduser -S -u 10001 -G appuser appuser
# node_modules целиком: Prisma CLI нужен для migrate deploy при старте
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=webapp /w/dist ./webapp
# Сертификаты УЦ Минцифры: без них TLS к platform-api2.max.ru не проходит (см. backend/certs/README.md)
COPY backend/certs ./certs
COPY backend/package.json ./
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/netcheck.mjs /usr/local/lib/netcheck.mjs
# Страховка от переводов строк Windows, если файл правили в Блокноте
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

# ipv4first: если у контейнера нет рабочего IPv6, fetch не должен пытаться идти через него
ENV NODE_ENV=production \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    MAX_MODE=webhook \
    PORT=3000 \
    DATA_DIR=/data \
    DATABASE_URL=file:/data/app.db
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
