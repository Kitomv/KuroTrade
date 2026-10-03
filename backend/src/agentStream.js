// Server-Sent Events for the Agents page.
//
// The Agents screen used to poll four endpoints (autopilot 4s, signals 5s,
// watchlist 10s, llm 10s) plus a 15s realMode effect. Each of those polls was a
// request the backend had to serve AND a trigger that could buy a full
// Bull/Bear/Lead scan. SSE turns that around: the server pushes when state
// actually changes, so the terminal and equity curve are current the moment
// the guardian writes them instead of up to 4s later, and a page nobody is
// looking at costs zero requests.
//
// Design notes:
//  - Full snapshots, not deltas. That is what makes resume trivial: a
//    reconnect gets the current state for every channel on connect, which is
//    strictly newer than anything a replay buffer could have held — so there is
//    no ring buffer to size, expire, or leak.
//  - Change detection is a signature compare per channel, held per
//    subscriber. Two tabs each track their own state, so a tab opened late is
//    not starved by an earlier tab's pushes.
//  - The guardian push is SYNCHRONOUS and the radar push is NOT AWAITED. A
//    fresh scan costs two rounds of LLM calls (~8s), and it runs on the same
//    loop as the 5s guardian tick; awaiting it there would starve position
//    protection — the one thing that must never wait on a radar refresh.
//  - Scan cost is unchanged from the old 5s poll: signals are fetched with the
//    same cached call, and only for users who actually have a subscriber.
//  - Heartbeat every 15s keeps proxies from reaping an idle connection.

import { getAutopilot, scanMarketSignals } from './aiAgent.js';
import { getLLMConfig } from './llmClient.js';
import { getUser } from './auth.js';
import { sanitizeError } from './security.js';

const HEARTBEAT_MS = 15_000;
const SIGNALS_LIMIT = 6;
// A stalled reader (suspended laptop, throttled background tab) closes the TCP
// window without either end going away, so the socket stays "open" while Node
// keeps appending to it. Cap the backlog and drop the subscriber: skipping the
// write is not enough, because the buffer is already full by then.
const MAX_BUFFERED_BYTES = 1_000_000;
// One page, one stream. A second tab is legitimate; an unbounded loop is not.
const MAX_STREAMS_PER_USER = 4;
// The session TTL is 14 days, but a stream opened at login used to live that
// whole time. Re-check the session on every heartbeat instead.
const SIGNAL_HISTORY_LIMIT = 30;

/** userId -> Set<subscriber>. A subscriber is `{ res, sigs, lastSeq, userId, token }`. */
const subscribers = new Map();
/** userId -> promise, so overlapping ticks cannot stack scans on one user. */
const signalsInFlight = new Map();

/**
 * Cheap fingerprint of the guardian state. Anything the UI renders must appear
 * here or the change is never pushed and the page silently freezes — which is
 * the exact failure this module can introduce, so the field list is pinned by
 * frontend/scripts/agentStream.check.mts.
 */
export function autopilotSignature(ap) {
  const logs = ap?.logs ?? [];
  const last = logs.length ? logs[0] : null;
  const eq = ap?.pnlHistory ?? [];
  const lastEq = eq.length ? eq[eq.length - 1] : null;
  return [
    ap?.enabled ? 1 : 0,
    ap?.status ?? '',
    ap?.lastScanAt ?? 0,
    logs.length,
    last ? last.ts : 0,
    ap?.guardedPositionsCount ?? 0,
    // Price moves change guarded PnL without touching any of the above.
    (ap?.guardedPositions ?? []).map((p) => `${p.address}${p.pnlPct}${p.status}${p.missingTicks}`).join(','),
    eq.length,
    lastEq ? `${lastEq.ts}:${lastEq.totalValue}` : '',
    ap?.stats?.totalTrades ?? 0,
    ap?.stats?.totalProfitUsd ?? 0,
  ].join('|');
}

/** Fingerprint of the radar list — price moves change the entry price. */
export function signalsSignature(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return 'empty';
  return reports
    .map((r) => `${r.token.address}:${r.verdict.signal}:${r.verdict.confidence}:${Number(r.verdict.entryPrice ?? 0).toFixed(8)}`)
    .join('|');
}

/**
 * Drop a subscriber that can no longer be written to.
 *
 * Both checks are needed and neither alone is sufficient:
 *  - `destroyed` — a socket that died after its last heartbeat. `res.write()` on
 *    it returns false WITHOUT throwing and emits no `error`, so the try/catch in
 *    the caller never fires and a dead subscriber would sit in the map forever.
 *  - `writableLength` — a socket that is alive but not draining. It never errors
 *    and never closes, so without this cap Node appends to the backlog forever.
 */
function isDead(sub) {
  return sub.res.destroyed || sub.res.writableLength > MAX_BUFFERED_BYTES;
}

function dropIfDead(userId, sub) {
  if (!isDead(sub)) return false;
  detach(userId, sub);
  sub.res.destroy();
  return true;
}

/**
 * Write one event. `payload` is a PRE-SERIALIZED string, because the same
 * snapshot goes to every subscriber of a user and `JSON.stringify` on a large
 * object is expensive enough that doing it per-subscriber blocks the event loop.
 */
function writeEvent(sub, event, payload) {
  if (isDead(sub)) return;
  sub.lastSeq += 1;
  sub.res.write(`id: ${sub.lastSeq}\nevent: ${event}\ndata: ${payload}\n\n`);
}

/**
 * The wire shape of the autopilot channel.
 *
 * `getAutopilot` returns the whole guardian state, ~180 KB on a mature account,
 * and the page renders a small fraction of it: `pendingSignals` (89 KB) is the
 * accuracy pipeline's internal queue and is never read by the UI, and only the
 * top 30 rows of `signalHistory` are ever drawn. Shipping the rest means
 * serializing and pushing ~8x more than is displayed, every tick. `getAutopilot`
 * already trims `memory`/`nearMisses` to 20 for the same reason.
 */
function slimAutopilot(ap) {
  return {
    ...ap,
    pendingSignals: undefined,
    signalStats: undefined,
    slCooldowns: undefined,
    signalHistory: (ap?.signalHistory ?? []).slice(0, SIGNAL_HISTORY_LIMIT),
  };
}

/** Signals fetch that never throws — a failed scan must not kill the stream. */
async function safeSignals(userId, autopilotEnabled) {
  try {
    return await scanMarketSignals(userId, SIGNALS_LIMIT, { allowStale: true, autopilotEnabled });
  } catch (e) {
    // null means "unknown", NOT "no signals". Returning [] here would blank the
    // radar table on a transient provider 429 and tell the user the market is
    // empty when really the scan just failed. The next successful scan refills
    // it; skipping this push keeps the last good list on screen meanwhile.
    console.warn(`[agents-stream] ${userId}: signals scan failed: ${sanitizeError(e?.message ?? e)}`);
    return null;
  }
}

function subscribersFor(userId) {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set();
    subscribers.set(userId, set);
  }
  return set;
}

function detach(userId, sub) {
  const set = subscribers.get(userId);
  if (!set) return;
  set.delete(sub);
  if (set.size === 0) subscribers.delete(userId);
}

/**
 * Attach an HTTP response as an SSE subscriber for `userId`.
 *
 * The guardian snapshot and LLM status are written immediately — they are
 * synchronous reads, so first paint does not wait on anything. The radar is
 * pushed as soon as its scan settles; `scanMarketSignals` serves a stale scan
 * straight away under `allowStale`, so in practice that is the current data.
 */
export function subscribeUser(userId, req, res) {
  const existing = subscribers.get(userId);
  // The route is exempt from the request rate limiter because it is one
  // long-lived connection rather than a flood — but nothing enforced "one".
  // Without this, a single valid token can hold open as many sockets as it
  // likes, each paying a per-tick serialize + write on the shared event loop.
  if (existing && existing.size >= MAX_STREAMS_PER_USER) {
    res.status(429).set('Retry-After', '30').json({ error: 'too many open streams' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx (and any buffering proxy) to stream instead of accumulating.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n'); // browser reconnect hint; the client also backs off

  const sub = {
    res,
    sigs: {},
    lastSeq: 0,
    userId,
    // Re-validated on every heartbeat: the middleware only checks the session
    // once per request, so a stream would otherwise outlive a revoked token by
    // up to the 14-day session TTL.
    token: (req.headers.authorization ?? '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '',
  };
  subscribersFor(userId).add(sub);
  const drop = () => detach(userId, sub);
  req.on('close', drop);
  res.on('close', drop);
  res.on('error', drop);

  const ap = getAutopilot(userId);
  sub.sigs.autopilot = autopilotSignature(ap);
  writeEvent(sub, 'autopilot', JSON.stringify(slimAutopilot(ap)));
  writeEvent(sub, 'llm', JSON.stringify(getLLMConfig(userId)));
  pushSignals(userId, ap.enabled);
}

/**
 * Push the radar list. Fire-and-forget by design — see the module header for
 * why this must never be awaited by the caller. Deduped per user so two ticks
 * landing during one slow scan cannot start a second.
 */
function pushSignals(userId, autopilotEnabled) {
  const set = subscribers.get(userId);
  if (!set || set.size === 0 || signalsInFlight.has(userId)) return;
  const promise = safeSignals(userId, autopilotEnabled)
    .then((reports) => {
      if (reports === null) return; // scan failed — keep the last good list
      const sig = signalsSignature(reports);
      const payload = JSON.stringify(reports);
      for (const sub of subscribers.get(userId) ?? []) {
        if (sub.sigs.signals !== sig) {
          sub.sigs.signals = sig;
          writeEvent(sub, 'signals', payload);
        }
      }
    })
    .catch(() => {})
    .finally(() => signalsInFlight.delete(userId));
  signalsInFlight.set(userId, promise);
}

/**
 * Push whatever changed for `userId`. Called once per guardian tick and after
 * every state-mutating request. Returns immediately when nobody is watching,
 * so the common case costs one map lookup.
 */
export function pushForUser(userId) {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;

  const ap = getAutopilot(userId);
  const sig = autopilotSignature(ap);
  // Serialize ONCE for the whole user, not once per subscriber.
  let payload = null;
  for (const sub of set) {
    if (sub.sigs.autopilot !== sig) {
      if (payload === null) payload = JSON.stringify(slimAutopilot(ap));
      sub.sigs.autopilot = sig;
      writeEvent(sub, 'autopilot', payload);
    }
  }
  pushSignals(userId, ap.enabled);
}

/** Push the LLM status alone — the config only changes on an explicit save. */
export function pushLlmForUser(userId) {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(getLLMConfig(userId));
  for (const sub of set) writeEvent(sub, 'llm', payload);
}

// Keep-alive, and the only place a dead or revoked subscriber is noticed.
// unref'd so importing this module never holds a process open.
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [userId, set] of subscribers.entries()) {
    for (const sub of set) {
      // Session revoked or expired since the last tick (logout, password
      // change, 14-day TTL). The route middleware only runs per request, so
      // without this a revoked token keeps receiving private autopilot state
      // for the rest of the TTL.
      if (sub.token && !getUser(sub.token)) {
        detach(userId, sub);
        try {
          sub.res.write('event: session-expired\ndata: {}\n\n');
          sub.res.end();
        } catch {
          // already gone
        }
        continue;
      }
      if (dropIfDead(userId, sub)) continue;
      sub.res.write(`: ping ${now}\n\n`);
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();