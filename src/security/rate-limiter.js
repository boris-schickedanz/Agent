const GLOBAL_KEY = 'global';

export class RateLimiter {
  constructor(db, config) {
    this.db = db;
    this.limit = config.rateLimitPerMinute;

    this._stmts = {
      get: db.prepare(
        'SELECT token_count FROM rate_limits WHERE user_id = ? AND window_start = ?'
      ),
      upsert: db.prepare(`
        INSERT INTO rate_limits (user_id, window_start, token_count)
        VALUES (?, ?, 1)
        ON CONFLICT(user_id, window_start) DO UPDATE SET token_count = token_count + 1
      `),
      cleanup: db.prepare(
        'DELETE FROM rate_limits WHERE window_start < ?'
      ),
    };
  }

  /**
   * Try to consume one token from the global rate limit bucket.
   */
  consume() {
    const now = Math.floor(Date.now() / 60_000);

    this._stmts.cleanup.run(now - 5);

    const row = this._stmts.get.get(GLOBAL_KEY, now);
    const currentCount = row ? row.token_count : 0;

    if (currentCount >= this.limit) {
      const windowEndMs = (now + 1) * 60_000;
      return {
        allowed: false,
        retryAfterMs: windowEndMs - Date.now(),
      };
    }

    this._stmts.upsert.run(GLOBAL_KEY, now);

    return { allowed: true, retryAfterMs: 0 };
  }

  reset() {
    this.db.prepare('DELETE FROM rate_limits WHERE user_id = ?').run(GLOBAL_KEY);
  }
}
