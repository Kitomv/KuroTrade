// Deadline wrapper for a background tick that must not be able to stall the
// loop it runs in.
//
// The autopilot tick is where every protective exit lives — hard stop-loss,
// trailing stop, TP2, the defensive bear-dump exit — and they run NOWHERE else.
// A tick that never settles therefore does not merely delay one user: it stops
// the exits for every user queued behind it in the same sweep.
//
// Two failure modes, and they need opposite treatment. Both are handled here so
// a caller cannot get one right and the other wrong.
//
//   OVERLAP — a per-user single-flight flag stops a second tick from starting
//   over the top of a slow one. It must be released when the TICK settles, not
//   when the deadline wins the race. Releasing on the race is the exact bug
//   this file exists to make impossible: the next sweep would launch a
//   concurrent second tick for a user whose first one is still running. Hence
//   `finally` on the tick, never on the race.
//
//   STALL — racing a deadline stops the LOOP waiting; it does not cancel the
//   work, and that is deliberate. Aborting mid-tick would tear down a guardian
//   partway through evaluating exits, and the replacement tick would overlap the
//   abandoned one anyway. A slow tick keeps its slot until it genuinely
//   finishes; everyone behind it is served immediately.
//
// `running` is passed in rather than owned here so the flag's lifetime stays
// with the loop that declared it, next to that loop's other state.

/** Distinguishable from a tick's own `null`, which means "autopilot disabled". */
export const TICK_DEADLINE = Symbol('tick deadline');

/** The slot was already held — the previous tick has not finished. */
export const TICK_BUSY = Symbol('tick busy');

/**
 * Run one tick under a deadline, holding `running` for its true duration.
 *
 * Refuses immediately when the slot is already taken. That check has to live
 * here rather than in the caller: it is the one line standing between a
 * deadline-releasing sweep and two concurrent guardian ticks evaluating the same
 * user's stop-loss, and every caller would otherwise have to remember it.
 *
 * @param {Set<string>} running    per-key single-flight flags, owned by the caller
 * @param {string} key            the slot this tick occupies
 * @param {() => Promise<T>} start the work; must be safe to abandon, not to interrupt
 * @param {number} deadlineMs     how long the caller waits before moving on
 * @returns {Promise<T | symbol>}  the tick's value, TICK_BUSY, or TICK_DEADLINE
 * @template T
 */
export async function runTickWithDeadline(running, key, start, deadlineMs) {
  if (running.has(key)) return TICK_BUSY;
  running.add(key);
  // `Promise.resolve().then(start)` rather than `start()` directly: a tick that
  // throws SYNCHRONOUSLY would otherwise escape before `.finally` is attached,
  // and the key would stay claimed forever — wedging that user out of autopilot
  // with no error anywhere.
  const tick = Promise.resolve()
    .then(start)
    .finally(() => running.delete(key));

  let timer;
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TICK_DEADLINE), deadlineMs);
    });
    return await Promise.race([tick, deadline]);
  } finally {
    // The tick may still be in flight, but nothing is waiting on this deadline
    // any more — clearing it stops the timer from holding the event loop open.
    clearTimeout(timer);
  }
}