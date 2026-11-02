/** A small fixed-window rate limiter kept in memory. Fine for one server process. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private window(key: string, now: number) {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) if (v.resetAt <= now) this.windows.delete(k);
      }
    }
    return w;
  }

  /** Counts one hit. Returns false once the key is over the limit for this window. */
  hit(key: string, now = Date.now()): boolean {
    const w = this.window(key, now);
    w.count++;
    return w.count <= this.max;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.window(key, now).count >= this.max;
  }
}
