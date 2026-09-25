import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { describeError } from '../max/client.js';

/** P2002 — нарушение уникальности в Prisma. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Идемпотентность (ТЗ 5.1.5). Отметка ставится ДО обработки: вставка в
 * processed_updates атомарна, поэтому из двух одновременных доставок одного
 * события пройдёт ровно одна. Обратная сторона — если обработка упала, повтор
 * это событие не обработает; для нас это верно, т.к. 200 уже отдан и MAX
 * повторять не будет, а дубль заявки хуже потерянного сообщения.
 */
export async function markProcessed(db: Db, key: string): Promise<boolean> {
  try {
    await db.processedUpdate.create({ data: { id: key } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Удаляет записи старше ttlMs. */
export async function cleanupProcessed(db: Db, ttlMs = 24 * 60 * 60 * 1000): Promise<number> {
  const { count } = await db.processedUpdate.deleteMany({
    where: { processedAt: { lt: new Date(Date.now() - ttlMs) } },
  });
  return count;
}

/** Фоновая чистка раз в час. Возвращает функцию остановки. */
export function startDedupCleanup(db: Db, log: Logger, everyMs = 60 * 60 * 1000): () => void {
  const run = () =>
    cleanupProcessed(db)
      .then((n) => n > 0 && log.info({ removed: n }, 'processed_updates: очищено'))
      .catch((err) => log.error(`processed_updates: ошибка очистки — ${describeError(err)}`));
  void run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
