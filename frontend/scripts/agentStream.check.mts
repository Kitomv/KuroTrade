// Runnable self-checks for the SSE frame parser and the backend change
// signatures. No framework: plain asserts, wired to `npm run check` alongside
// the evmDiscovery/chainMap checks.
//
// These cover the two places the realtime path can fail silently:
//  1. framing — a chunk boundary in the middle of a frame must not corrupt or
//     drop an event (the browser reader delivers arbitrary chunk sizes), and
//     keep-alive comments must not surface as data.
//  2. signatures — a change the UI renders MUST change the signature, or the
//     push is skipped and the page silently freezes. That is the exact class of
//     bug this feature introduces, so it is pinned here.
//
// Run: node scripts/agentStream.check.mts  (via `npm run check`)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/* ---------------- SSE framing ---------------- */

// The hook is browser code, so it cannot be imported here. Re-implement the two
// pure functions identically and check the BEHAVIOUR; a source guard below
// fails if the real implementation drifts away from this one.
const parseFrames = (buffer: string): { frames: string[]; rest: string } => {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
};

const parseFrame = (frame: string): { event: string; data: unknown } | null => {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
};

/** Feed a stream through the parser chunk-by-chunk, return every decoded event. */
function drain(chunks: string[]): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const { frames, rest } = parseFrames(buffer);
    buffer = rest;
    for (const f of frames) {
      const parsed = parseFrame(f);
      if (parsed) out.push(parsed);
    }
  }
  assert.equal(buffer, '', `flush left an unparsed tail: ${JSON.stringify(buffer)}`);
  return out;
}

// A whole frame arriving in one chunk.
{
  const events = drain(['event: autopilot\ndata: {"status":"GUARDIAN"}\n\n']);
  assert.deepEqual(events, [{ event: 'autopilot', data: { status: 'GUARDIAN' } }]);
}

// THE regression this guards: the reader can split anywhere. A payload cut in
// half must be held in the buffer, not parsed as a truncated event.
{
  const full = 'event: signals\ndata: [{"token":{"symbol":"AAA"},"verdict":{"signal":"BUY"}}]\n\n';
  const cut = Math.floor(full.length / 2);
  const events = drain([full.slice(0, cut), full.slice(cut)]);
  assert.equal(events.length, 1, 'the split frame must survive');
  assert.equal(events[0].event, 'signals');
  assert.equal((events[0].data as any[])[0].token.symbol, 'AAA');
}

// Several frames plus a heartbeat comment in one chunk.
{
  const events = drain([
    ': ping 1\n\n' +
    'event: autopilot\ndata: {"status":"SCANNING"}\n\n' +
    'event: llm\ndata: {"provider":"9router"}\n\n',
  ]);
  assert.equal(events.length, 2, 'the comment is not an event');
  assert.deepEqual(events.map((e) => e.event), ['autopilot', 'llm']);
}

// A one-character-at-a-time drip is the worst case for the tail buffer.
{
  const full = 'retry: 3000\n\nevent: autopilot\ndata: {"enabled":true}\n\n';
  const events = drain(full.split(''));
  assert.equal(events.length, 1);
  assert.equal((events[0].data as any).enabled, true);
}

// CRLF framing (some proxies rewrite) must parse identically. THE regression:
// the frame terminator becomes `\r\n\r\n`, which contains no `\n\n`, so a parser
// that splits on `\n\n` alone never finds a boundary and the connection stalls
// silently with no error.
{
  const events = drain(['event: llm\r\ndata: {"provider":"openai"}\r\n\r\n']);
  assert.deepEqual(events, [{ event: 'llm', data: { provider: 'openai' } }]);
}

// The same CRLF stream split across an arbitrary chunk boundary — including one
// landing between the `\r` and the `\n`, where the tail holds a lone `\r`.
{
  const full = 'event: autopilot\r\ndata: {"status":"GUARDIAN"}\r\n\r\n';
  for (let cut = 1; cut < full.length; cut++) {
    const events = drain([full.slice(0, cut), full.slice(cut)]);
    assert.equal(events.length, 1, `CRLF frame split at ${cut} must survive`);
    assert.deepEqual(events[0], { event: 'autopilot', data: { status: 'GUARDIAN' } });
  }
}

// A truncated JSON payload is skipped, not thrown — one bad frame must not
// take down a healthy connection.
{
  assert.equal(parseFrame('event: autopilot\ndata: {"status":'), null);
}

// The hook's parser must match the one exercised above.
{
  const src = readFileSync(join(here, '..', 'src', 'hooks', 'useAgentStream.ts'), 'utf8');
  for (const marker of ["replace(/\\r\\n/g, '\\n')", "split('\\n\\n')", "line.startsWith(':')", 'JSON.parse(dataLines.join', "replace(/\\r$/, '')"]) {
    assert.ok(src.includes(marker), `useAgentStream.ts must keep the checked parser behaviour (${marker})`);
  }
}

/* ---------------- backend resource safety ---------------- */

// Four ways this stream can exhaust the server it runs on. Each assertion here
// exists because the failure is silent — no crash, no log, just a process that
// eats memory or blocks the guardian tick until it OOMs.
{
  const backend = readFileSync(join(here, '..', '..', 'backend', 'src', 'agentStream.js'), 'utf8');
  const code = backend.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // 1. Backpressure. `res.write()` returning false is NOT an error and does not
  //    throw — a stalled reader leaves the socket open forever while Node keeps
  //    appending. Without a writableLength cap the buffer grows until OOM.
  assert.ok(/writableLength\s*>\s*MAX_BUFFERED_BYTES/.test(code), 'a stalled subscriber must be dropped, not just skipped');
  assert.ok(/res\.destroy\(\)/.test(code), 'an undrainable socket must actually be destroyed');

  // 2. Dead sockets. `res.write()` on a destroyed socket returns false WITHOUT
  //    throwing, so a try/catch around the write can never fire and the dead
  //    subscriber would sit in the map forever.
  assert.ok(/sub\.res\.destroyed\s*\|\|/.test(code), 'writeEvent must check res.destroyed — the catch never fires');

  // 3. Per-user cap. The route is exempt from the request rate limiter because
  //    it is one connection, not a flood; nothing enforced "one".
  assert.ok(/existing\.size\s*>=\s*MAX_STREAMS_PER_USER/.test(code), 'concurrent streams per user must be capped');
  assert.match(backend, /res\.status\(429\)/);

  // 4. Session re-validation. The auth middleware runs once per request, so an
  //    open stream outlives a revoked token by up to the 14-day session TTL.
  assert.ok(/!getUser\(sub\.token\)/.test(code), 'the heartbeat must re-check the session');
  assert.match(backend, /event: session-expired/);

  // Payload size. `getAutopilot` returns ~180 KB; the UI reads a fraction of it.
  // `pendingSignals` (the accuracy pipeline's queue) is never rendered, and only
  // the top 30 rows of `signalHistory` are drawn.
  assert.ok(/pendingSignals:\s*undefined/.test(code), 'the never-rendered pendingSignals queue must not be shipped');
  assert.ok(/signalHistory:.*slice\(0, SIGNAL_HISTORY_LIMIT\)/.test(code), 'signalHistory must be truncated to what the UI draws');
  assert.ok(/signalStats:\s*undefined/.test(code) && /slCooldowns:\s*undefined/.test(code));

  // Serialize once per push, not once per subscriber: `JSON.stringify` on this
  // object is ~1.5ms of blocking event-loop time, and the guardian tick must
  // never be delayed behind it.
  const push = backend.slice(backend.indexOf('export function pushForUser'));
  assert.ok(
    /payload\s*===\s*null\s*\)\s*payload\s*=\s*JSON\.stringify/.test(push.replace(/\s+/g, ' ')),
    'the autopilot payload must be serialized once, outside the subscriber loop',
  );
  assert.ok(!/writeEvent\([^)]*,\s*ap\s*\)/.test(push), 'writeEvent must take a pre-built string, not the raw object');

  // A failed scan is `null` ("unknown"), never `[]` ("no signals") — returning
  // [] blanks the radar table on a transient provider 429.
  assert.ok(/return null;\s*\n\s*\}/.test(backend), 'safeSignals must return null on failure');
  assert.ok(/if \(reports === null\) return;/.test(code), 'a null scan must skip the push, not write an empty list');

  // The client must tear the session down on that event, or it reconnects in a
  // loop with the same dead token.
  const hook = readFileSync(join(here, '..', 'src', 'hooks', 'useAgentStream.ts'), 'utf8');
  assert.ok(hook.includes("parsed.event === 'session-expired'"), 'the hook must handle session-expired');
  assert.ok(
    /session-expired[\s\S]{0,400}trading_token/.test(hook),
    'session-expired must clear the token, matching the 401 path',
  );
}

/* ---------------- wire-format coupling ---------------- */

// The parser and the server's `writeEvent` are a contract across a process
// boundary: if the backend ever reorders its fields or drops the `id:` line,
// this parser degrades SILENTLY — frames still parse, but `id` leaks into the
// data path or reconnect bookkeeping breaks. Pin the exact bytes the server
// produces, read from the backend source rather than a hand-copied copy.
{
  const backend = readFileSync(join(here, '..', '..', 'backend', 'src', 'agentStream.js'), 'utf8');
  const writeEvent = backend.slice(backend.indexOf('function writeEvent'));
  const template = writeEvent.slice(0, writeEvent.indexOf('}\n'));
  assert.match(template, /id: \$\{sub\.lastSeq\}\\nevent: \$\{event\}\\ndata: \$\{payload\}\\n\\n/);
  assert.match(backend, /res\.write\('retry: 3000\\n\\n'\)/);
  assert.match(backend, /`: ping \$\{now\}\\n\\n`/);

  // Feed the server's real preamble + a heartbeat + one event, as one chunk.
  const wire = 'retry: 3000\n\n'
    + 'id: 1\nevent: autopilot\ndata: {"enabled":true,"status":"GUARDIAN"}\n\n'
    + ': ping 1756722000000\n\n'
    + 'id: 2\nevent: llm\ndata: {"provider":"9router"}\n\n';
  const events = drain([wire]);
  assert.deepEqual(events.map((e) => e.event), ['autopilot', 'llm'], 'retry:/id:/heartbeat are not events');
  assert.deepEqual(events[0].data, { enabled: true, status: 'GUARDIAN' });
}

/* ---------------- fallback gating ---------------- */

// The fallback pollers must actually STOP while the stream is healthy. usePolling
// has no enable switch beyond the 4th argument, and its effect always starts on
// mount — passing `streamDown` in deps alone only restarts it, never stops it,
// which would leave the old polling running forever alongside the stream.
{
  const src = readFileSync(join(here, '..', 'src', 'hooks', 'usePolling.ts'), 'utf8');
  assert.ok(src.includes('if (!enabled) return;'), 'usePolling must honour enabled');
  assert.ok(src.includes('[enabled, ...deps]'), 'usePolling must re-run when enabled flips');
  const page = readFileSync(join(here, '..', 'src', 'pages', 'Agents.tsx'), 'utf8');
  // Gated — these three have a stream channel, so polling them alongside it is
  // pure waste.
  assert.match(page, /usePolling\(\(\) => api\.getAutopilot\(\), 4_000, \[\], streamDown\)/);
  assert.match(page, /usePolling\(\(\) => api\.agentSignals\(6\), 5_000, \[\], streamDown\)/);
  assert.match(page, /usePolling\(\(\) => api\.getLLMConfig\(\), 10_000, \[llmVersion\], streamDown\)/);
  // NOT gated — the stream carries no watchlist channel, so gating it would leave
  // the list permanently empty. Pinned so a well-meaning "gate them all" edit
  // cannot silently blank the watchlist again.
  assert.match(page, /usePolling\(\(\) => api\.watchlist\(\), 10_000\)/);
}

// THE regression this guards: the hook keeps its last snapshot after a drop, so
// `stream.autopilot` stays non-null forever once any event lands. Merging with a
// bare `??` would prefer that frozen snapshot over the live fallback forever —
// the polls run, buy the same LLM scans the stream exists to avoid, and get their
// result discarded. The page sits on stale numbers with every indicator healthy.
// The merge MUST be gated on `stream.connected`.
{
  const page = readFileSync(join(here, '..', 'src', 'pages', 'Agents.tsx'), 'utf8');
  assert.match(page, /const live = stream\.connected \? stream : null/);
  for (const field of ['autopilot', 'signals', 'llm']) {
    assert.match(page, new RegExp(`live\\?\\.${field} \\?\\? `), `${field} must merge through the connected gate`);
  }
  // Strip comments first: the code explains this exact anti-pattern in prose
  // ("a bare `stream.autopilot ?? autopilotP.data` would…"), and the guard must
  // test executable code, not the warning that documents it.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/stream\.(autopilot|signals|llm)\s*\?\?/.test(code),
    'the stream snapshot must never win without the connected gate — a stale snapshot would mask the fallback',
  );
}

// Unmount must NOT be signalled by clearing `enabled`. If the cleanup does that,
// any later effect re-run (caller flips `enabled`, StrictMode double-invoke)
// early-returns in `connect()` forever and the stream is permanently dead.
{
  const src = readFileSync(join(here, '..', 'src', 'hooks', 'useAgentStream.ts'), 'utf8');
  assert.ok(!/enabledRef\.current\s*=\s*false/.test(src), 'cleanup must not clear enabledRef — it strands the hook on re-run');
  assert.ok(/disposedRef\.current\s*=\s*false/.test(src), 'the effect must re-arm disposedRef on every run');
}

/* ---------------- permanent failures must not be retried ---------------- */

// The 404 this shipped with produced one request every 30s for as long as the tab
// stayed open — a reconnect loop against a route that does not exist, logging a
// console error and nothing else. `return` in the catch does NOT skip `finally`,
// so the retry is stopped in two places and both are pinned: the status check
// itself, and the backoff that must not fire behind it.
{
  const hook = readFileSync(join(here, '..', 'src', 'hooks', 'useAgentStream.ts'), 'utf8');

  // Mirror of isRetryableStatus. 401 tears the session down separately; 429 is
  // the server's own "too many open streams" and clears on its own.
  const isRetryableStatus = (status: number) => status === 429 || status >= 500;
  for (const status of [404, 403, 400, 401]) {
    assert.equal(isRetryableStatus(status), false, `${status} must not be retried`);
  }
  for (const status of [429, 500, 501, 502, 503]) {
    // 501 included deliberately: it is a 5xx, so it clears on its own even
    // though the status code reads like a permanent "not implemented".
    assert.equal(isRetryableStatus(status), true, `${status} is worth retrying`);
  }

  // The guard itself, in the hook — the mirror above proves nothing if the real
  // function differs.
  assert.match(hook, /status === 429 \|\| status >= 500/, 'the hook must keep the checked retry rule');
  assert.match(hook, /if \(!isRetryableStatus\(res\.status\)\)/);
  assert.match(hook, /fatalRef\.current = true/, 'a permanent failure must set the fatal latch');

  // Both places that could restart it. The finally is the one that matters —
  // it runs regardless of where the try block exited.
  const finallyBlock = hook.slice(hook.lastIndexOf('} finally {'));
  const before = finallyBlock.slice(0, finallyBlock.indexOf('setTimeout'));
  assert.ok(/fatalRef\.current\) return;/.test(before), 'the backoff must be skipped after a fatal error');
  assert.match(
    hook,
    /!abortRef\.current && !timerRef\.current && !fatalRef\.current/,
    'showing a hidden tab must not resurrect a fatally-failed stream',
  );
  assert.match(
    hook,
    /fatalRef\.current = false; \/\/ a caller flipping/,
    'a caller re-enabling the hook must clear the latch — a stream the user asked to retry must actually retry',
  );
}

/* ---------------- hidden tab must stay closed ---------------- */

// The reconnect `finally` block must not fire for a hidden tab. `return` inside
// the catch does NOT skip `finally`, so without a `document.hidden` guard here,
// hiding the tab aborts the stream and the finally immediately schedules the
// reconnect that the visibility handler just cancelled.
{
  const src = readFileSync(join(here, '..', 'src', 'hooks', 'useAgentStream.ts'), 'utf8');
  const finallyBlock = src.slice(src.lastIndexOf('} finally {'));
  assert.ok(
    /document\.hidden/.test(finallyBlock.slice(0, finallyBlock.indexOf('setTimeout'))),
    'the reconnect finally must bail when document.hidden — otherwise a hidden tab reconnects',
  );
}

/* ---------------- change signatures ---------------- */

// Mirror of backend/src/agentStream.js autopilotSignature, exercised through
// the same field list so a field the UI renders cannot be dropped silently.
function autopilotSignature(ap: any): string {
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
    (ap?.guardedPositions ?? []).map((p: any) => `${p.address}${p.pnlPct}${p.status}${p.missingTicks}`).join(','),
    eq.length,
    lastEq ? `${lastEq.ts}:${lastEq.totalValue}` : '',
    ap?.stats?.totalTrades ?? 0,
    ap?.stats?.totalProfitUsd ?? 0,
  ].join('|');
}

const base = {
  enabled: true, status: 'GUARDIAN', lastScanAt: 1000,
  logs: [{ ts: 10, msg: 'a' }],
  guardedPositionsCount: 1,
  guardedPositions: [{ address: '0x1', pnlPct: 5, status: 'GUARDED', missingTicks: 0 }],
  pnlHistory: [{ ts: 9, totalValue: 100 }],
  stats: { totalTrades: 1, totalProfitUsd: 5 },
};
const sig0 = autopilotSignature(base);

for (const [label, mutate] of [
  ['enabled', (o: any) => { o.enabled = false; }],
  ['status', (o: any) => { o.status = 'SCANNING'; }],
  ['lastScanAt', (o: any) => { o.lastScanAt = 2000; }],
  ['a new log line', (o: any) => { o.logs.unshift({ ts: 11, msg: 'b' }); }],
  ['a guarded PnL move', (o: any) => { o.guardedPositions[0].pnlPct = 9; }],
  ['a guarded status flip', (o: any) => { o.guardedPositions[0].status = 'TP_TRIGGER'; }],
  ['a missing-market tick', (o: any) => { o.guardedPositions[0].missingTicks = 3; }],
  ['a new position', (o: any) => { o.guardedPositions.push({ address: '0x2', pnlPct: 1, status: 'GUARDED', missingTicks: 0 }); o.guardedPositionsCount = 2; }],
  ['an equity point', (o: any) => { o.pnlHistory.push({ ts: 10, totalValue: 110 }); }],
  ['realized PnL', (o: any) => { o.stats.totalProfitUsd = 12; }],
  ['a closed trade', (o: any) => { o.stats.totalTrades = 2; }],
] as Array<[string, (o: any) => void]>) {
  const next = structuredClone(base);
  mutate(next);
  assert.notEqual(autopilotSignature(next), sig0, `${label} must change the signature, or the push is skipped`);
}

// An unchanged snapshot must NOT re-push — otherwise the page re-renders every
// tick for nothing, which is the cost this feature exists to remove.
assert.equal(autopilotSignature(structuredClone(base)), sig0, 'an identical snapshot must not re-push');

// Missing fields must not crash the signature (an account hydrated from an old
// save has no pnlHistory / guardedPositions at all).
assert.equal(typeof autopilotSignature({ enabled: false }), 'string');

// The backend file must expose exactly these two signature helpers.
{
  const src = readFileSync(join(here, '..', '..', 'backend', 'src', 'agentStream.js'), 'utf8');
  for (const field of ['guardedPositionsCount', 'missingTicks', 'pnlHistory', 'totalProfitUsd']) {
    assert.ok(src.includes(field), `agentStream.js signature must cover ${field}`);
  }
}

console.log('agentStream checks passed');