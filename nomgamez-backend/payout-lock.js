// payout-lock.js — Per-entity processing lock
//
// Node.js is single-threaded, but `await` inside an async route handler yields
// the event loop. This means two concurrent requests for the same session/pass
// can both pass a state-check before either commits the write.
//
// This lock is checked SYNCHRONOUSLY before any await. If the key is already
// held, the second request is rejected immediately (no queue, no wait).
// The caller is expected to retry after a brief delay.
//
// For single-process Node this is sufficient. Multi-process requires a shared
// store (Redis SETNX), which is a Phase 2 concern.

class PayoutLock {
  constructor() {
    this._held = new Set();
  }

  /**
   * Try to acquire the lock for `key`.
   * Returns true if acquired, false if already held.
   *
   * MUST be called synchronously (before any await) inside the route handler.
   * MUST be released in a finally block via release(key).
   */
  tryAcquire(key) {
    if (this._held.has(key)) return false;
    this._held.add(key);
    return true;
  }

  /**
   * Release the lock for `key`.
   */
  release(key) {
    this._held.delete(key);
  }

  /**
   * Express middleware factory.
   * keyFn(req) → the lock key (e.g. req.params.id).
   * Rejects with 429 if the key is already held.
   */
  middleware(keyFn) {
    return (req, res, next) => {
      const key = keyFn(req);
      if (!this.tryAcquire(key)) {
        return res.status(429).json({
          error: 'Already processing — please retry in a moment',
          retryAfterMs: 2000,
        });
      }
      // Attach release to response finish so it's freed even on crashes
      const release = () => this.release(key);
      res.once('finish', release);
      res.once('close',  release);
      next();
    };
  }

  isHeld(key) { return this._held.has(key); }
  size()      { return this._held.size; }
}

// Singleton — shared across all routes in the process
const payoutLock = new PayoutLock();

module.exports = { PayoutLock, payoutLock };
