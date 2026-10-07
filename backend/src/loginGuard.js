// Rolling-window guard for failed logins, keyed by whatever the caller chooses
// (client IP, username). Extracted from server.js so the semantics are pinned
// by tests instead of read off the route handler.
//
// Why two keys: the per-IP guard stops one host hammering the route, but it
// sees nothing when a botnet sprays ONE account from many IPs — each attacker
// host stays under its own per-IP limit. The per-username guard is what makes
// that distributed guess infeasible; the trade-off is that an attacker can
// also lock a known username out for one window, which is why the window is
// short and a success clears the counter immediately.

const DEFAULT_MAX = 10;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {{ max?: number, windowMs?: number, now?: () => number }} [options]
 *   `now` is injectable so tests can move the clock without waiting.
 */
export function createLoginGuard({
  max = DEFAULT_MAX,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now,
} = {}) {
  const attempts = new Map(); // key -> { count, resetAt }

  const blocked = (key) => {
    if (!key) return false;
    const rec = attempts.get(key);
    if (!rec) return false;
    if (now() > rec.resetAt) { attempts.delete(key); return false; }
    return rec.count >= max;
  };

  const noteFailure = (key) => {
    if (!key) return;
    const t = now();
    const rec = attempts.get(key);
    if (rec && t <= rec.resetAt) { rec.count++; return; }
    attempts.set(key, { count: 1, resetAt: t + windowMs });
  };

  const clear = (key) => { if (key) attempts.delete(key); };

  // Drop stale entries so a long-lived process does not accumulate keys
  // forever. unref so the interval never holds the process open.
  const prune = setInterval(() => {
    const t = now();
    for (const [key, rec] of attempts) if (t > rec.resetAt) attempts.delete(key);
  }, Math.max(windowMs, 60_000));
  prune.unref?.();

  return { blocked, noteFailure, clear };
}
