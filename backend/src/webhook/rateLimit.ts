/**
 * Скользящее окно в памяти процесса: N событий за windowMs на ключ (user_id).
 * Для одного инстанса этого достаточно; при горизонтальном масштабировании
 * счётчик переезжает в общий стор.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** true — пропустить, false — лимит превышен. */
  allow(key: string): boolean {
    const t = this.now();
    const from = t - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  /** Удаляет пустые ключи, чтобы Map не рос бесконечно. */
  sweep(): void {
    const from = this.now() - this.windowMs;
    for (const [k, arr] of this.hits) {
      const live = arr.filter((x) => x > from);
      if (live.length === 0) this.hits.delete(k);
      else this.hits.set(k, live);
    }
  }
}
