// The autopilot tick owns every protective exit in this app — stop-loss,
// trailing, TP2, defensive bear-dump. Nothing else runs them. So the sweep that
// drives it is money-critical, and these tests pin the two ways it can stop
// doing its job: skipping a user whose predecessor is still running, and
// waiting on a user whose tick never settles.
//
// Run: node --test backend/src/tickGuard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTickWithDeadline, TICK_DEADLINE, TICK_BUSY } from './tickGuard.js';

/** A promise plus the handles to settle it later. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/* ---------------- overlap ---------------- */

test('one user\'s slow tick does not suppress another user\'s', async () => {
  // The bug being guarded: a single process-global flag meant user A's slow
  // tick skipped the sweep for user B too — and user B's stop-loss with it.
  const running = new Set();
  const slow = deferred();

  const a = runTickWithDeadline(running, 'user-a', () => slow.promise, 50);
  assert.deepEqual([...running], ['user-a'], 'the slow user holds only their own slot');

  // User B must be startable immediately, despite A still running.
  const b = await runTickWithDeadline(running, 'user-b', async () => 'B ran', 50);
  assert.equal(b, 'B ran');
  assert.deepEqual([...running], ['user-a'], "B's slot is released, A's is untouched");

  slow.resolve('A ran');
  assert.equal(await a, 'A ran');
  assert.equal(running.size, 0, 'every slot is released when its tick settles');
});

test('a second tick for the same user never starts over the first', async () => {
  // The subtle half: the flag must be released when the TICK settles, not when
  // the deadline wins the race. Releasing on the race lets sweep N+1 launch a
  // concurrent second tick while the abandoned one is still mid-exit.
  const running = new Set();
  const slow = deferred();
  const started = [];

  const first = runTickWithDeadline(running, 'u', () => {
    started.push('first');
    return slow.promise;
  }, 20);
  assert.equal(await first, TICK_DEADLINE, 'the deadline fires while the tick is still going');
  assert.equal(running.size, 1, 'the abandoned tick keeps its slot — it has not finished');

  // The next sweep must refuse to start, not run concurrently.
  const second = await runTickWithDeadline(running, 'u', () => {
    started.push('second');
    return Promise.resolve('should not happen');
  }, 20);
  assert.equal(second, TICK_BUSY, 'a busy user is skipped, not double-ticked');
  assert.deepEqual(started, ['first'], 'no second tick was ever started');

  slow.resolve('first finished');
  await tick();
  assert.equal(running.size, 0, 'the slot frees only once the abandoned tick truly ends');
});

test('the slot is released even when the tick throws synchronously', async () => {
  // A throw before any await would escape before `.finally` is attached and
  // wedge that user out of autopilot permanently, with nothing logged.
  const running = new Set();
  await assert.rejects(
    runTickWithDeadline(running, 'u', () => { throw new Error('sync boom'); }, 100),
    /sync boom/,
  );
  assert.equal(running.size, 0, 'a throwing tick must not hold its slot forever');
});

test('the slot is released when the tick rejects asynchronously', async () => {
  const running = new Set();
  await assert.rejects(
    runTickWithDeadline(running, 'u', async () => { throw new Error('async boom'); }, 100),
    /async boom/,
  );
  assert.equal(running.size, 0);
});

test('the tick still runs to completion after the deadline gave up on it', async () => {
  // Abandoning the WAIT is the whole design. If this ever becomes a real abort,
  // the guardian would be torn down partway through evaluating exits.
  const running = new Set();
  let finished = false;
  const slow = deferred();
  const res = await runTickWithDeadline(running, 'u', () => slow.promise.then(() => { finished = true; return 'late'; }), 20);
  assert.equal(res, TICK_DEADLINE);
  assert.equal(finished, false, 'the deadline does not cancel the work');

  slow.resolve();
  await tick();
  assert.equal(finished, true, 'the abandoned tick completes on its own');
});

/* ---------------- counterfactuals: prove these tests are not vacuous ------- */

test('WITHOUT the guard a slow tick blocks everyone — the behaviour we replaced', async () => {
  // The pre-fix loop was `if (globalFlag) return`. Reproduce it exactly: with a
  // process-global flag, a user stuck on a slow tick starves every other user,
  // stop-loss included. This is what the per-user Set exists to prevent, so the
  // test above only means something if this is the alternative.
  let globalFlag = false;
  const slow = deferred();

  const sweep = (async () => {
    if (globalFlag) return 'skipped';
    globalFlag = true;
    try { await slow.promise; return 'ran'; } finally { globalFlag = false; }
  })();

  await tick();
  const otherUser = globalFlag ? 'skipped' : 'ran';
  assert.equal(otherUser, 'skipped', 'a global flag starves the other user');

  slow.resolve();
  await sweep;
  assert.equal(globalFlag, false);
});

test('WITHOUT a deadline a slow tick holds the sweep indefinitely', async () => {
  // The second half of the original defect: awaiting the tick directly means
  // the loop waits as long as the slowest provider, however long that is.
  const slow = deferred();
  let served = false;
  const sweep = slow.promise.then(() => { served = true; });
  await tick();
  assert.equal(served, false, 'the sweep is still blocked on the tick');

  slow.resolve();
  await sweep;
  assert.equal(served, true);
});

test('the deadline symbol cannot be confused with a tick\'s own return value', async () => {
  // runAutopilotTick returns null when the autopilot is off. If the deadline
  // marker were a plain value like null or false, the sweep could not tell a
  // timed-out tick from a disabled one and would push/log against a tick that
  // never finished.
  const running = new Set();
  assert.notEqual(TICK_DEADLINE, null);
  assert.equal(await runTickWithDeadline(running, 'u', async () => null, 100), null, 'a real null passes through');
  const slow = deferred();
  assert.equal(await runTickWithDeadline(running, 'v', () => slow.promise, 20), TICK_DEADLINE);
  slow.resolve();
  await tick();
});

test('a busy slot returns without waiting for the deadline', async () => {
  // If the busy path also went through the race, a sweep would sit for the full
  // 30s on every already-running user before moving to the next one — turning
  // the fix into its own stall.
  const running = new Set();
  running.add('u');
  const started = Date.now();
  assert.equal(await runTickWithDeadline(running, 'u', () => Promise.resolve('x'), 30_000), TICK_BUSY);
  assert.ok(Date.now() - started < 100, 'the busy path must be immediate');
});