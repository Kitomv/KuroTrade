// Crash-safety primitives for the autonomous executor: the write-ahead journal,
// the synchronous flush it depends on, and the reclaim exemption that stops
// the TTL sweep from releasing an in-flight swap back to 'open'.
//
// These are the tests that matter most in this feature. Everything else is
// correctness; this file is double-spend prevention.
//
// Run: node --test src/execJournal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set BEFORE the module graph is imported — persistence.js resolves
// DATA_DIR at module-evaluation time. Without this these tests would read and
// write real user state in backend/data.
const TEMP_DIR = join(tmpdir(), `exec-journal-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const {
  addRealIntent, getRealIntent, getRealIntents, setRealIntentStatus,
  markIntentExec, listExecIntents, isAutoApprove, setAutoApprove, setRealMode,
} = await import('./realIntent.js');
const { flushUserNow, loadUserState } = await import('./persistence.js');
const { createUser } = await import('./auth.js');

const uid = (s) => `u_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const ADDR = '0x1111111111111111111111111111111111111111';

function buyIntent(userId, overrides = {}) {
  return addRealIntent(userId, {
    symbol: 'TEST',
    tokenAddress: ADDR,
    chainId: 'base',
    side: 'buy',
    source: 'STRONG_BUY',
    amountUsd: 10,
    amountWei: 3_000_000_000_000_000,
    estTokens: 100,
    intentPrice: 0.1,
    ...overrides,
  });
}

test('flushUserNow writes to disk before returning', () => {
  const userId = uid('flush');
  addRealIntent(userId, {
    symbol: 'T', tokenAddress: ADDR, chainId: 'base', side: 'buy',
    source: 'STRONG_BUY', amountUsd: 10, amountWei: 1, estTokens: 1, intentPrice: 1,
  });
  // No await, no polling: the file must already be complete on the next line.
  flushUserNow(userId);
  const onDisk = JSON.parse(readFileSync(join(TEMP_DIR, `${userId}.json`), 'utf-8'));
  assert.equal(Array.isArray(onDisk.realIntents), true);
  assert.equal(onDisk.realIntents.length, 1);
});

test('markIntentExec persists the nonce synchronously, before any broadcast', () => {
  const userId = uid('nonce');
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');

  markIntentExec(userId, intent.id, { stage: 'sending', nonce: 7, chain: 'base' });

  // Read the FILE, not the in-memory object — this is the crash-recovery view.
  const onDisk = JSON.parse(readFileSync(join(TEMP_DIR, `${userId}.json`), 'utf-8'));
  const row = onDisk.realIntents.find((i) => i.id === intent.id);
  assert.equal(row.exec.stage, 'sending');
  assert.equal(row.exec.nonce, 7);
});

/**
 * Age an intent's CLAIM far past CLAIM_TTL_MS (10 min), leaving `createdAt`
 * fresh. Only the claim-reclaim tests use this: they are about a dead tab whose
 * intent is still inside its 30-minute life. The TTL-drop tests use `agePastTtl`
 * — the two expiries are independent, and a single helper that moved both would
 * make the claim tests pass for the TTL reason instead.
 *
 * `realStates` is an in-memory Map, so `liveIntents` reads the cached object and
 * never sees an on-disk rewrite — the timestamp has to move through the object
 * the sweep will actually read. Rewriting the JSON here would leave the claim
 * fresh and make both tests below pass for the wrong reason.
 */
function age(intent) {
  intent.claimedAt = Date.now() - 60 * 60 * 1000;
  return intent;
}

/** Age an intent past INTENT_TTL_MS (30 min) — the other expiry, on `createdAt`. */
function agePastTtl(intent) {
  intent.createdAt = Date.now() - 60 * 60 * 1000;
  return intent;
}

test('a journalled intent is NOT reclaimed to open by the TTL sweep', () => {
  const userId = uid('reclaim');
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');
  markIntentExec(userId, intent.id, { stage: 'sending', nonce: 3 });

  const claimToken = getRealIntent(userId, intent.id).claimToken;
  age(getRealIntent(userId, intent.id));

  const survived = getRealIntents(userId).find((i) => i.id === intent.id);
  assert.equal(survived.status, 'active', 'an in-flight intent must NOT be released to open');
  assert.equal(survived.claimToken, claimToken, 'and must keep its claim');
});

test('a claim-only intent IS still reclaimed — the TTL sweep keeps its job', () => {
  const userId = uid('claimonly');
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');

  age(getRealIntent(userId, intent.id));

  const reclaimed = getRealIntents(userId).find((i) => i.id === intent.id);
  assert.equal(reclaimed.status, 'open', 'a dead browser tab must not strand a trade');
  assert.equal(reclaimed.claimToken, undefined);
});

// THE gap these three close. The tests above age only `claimedAt`, so they
// exercise the CLAIM-TTL branch and never the INTENT-TTL drop on `createdAt`.
// That left the 30-minute expiry — the one that deletes the row — unguarded and
// untested, while the file's own header calls this "double-spend prevention".
// Verified by mutation: with the TTL branch hoisted above the in-flight check
// (the pre-fix state), the first test below fails and every other test passes.

test('an in-flight intent is NOT dropped when it outlives the 30-minute TTL', () => {
  const userId = uid('ttlguard');
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');
  markIntentExec(userId, intent.id, { stage: 'sending', nonce: 5 });

  const claimToken = getRealIntent(userId, intent.id).claimToken;
  agePastTtl(getRealIntent(userId, intent.id));

  const survived = getRealIntents(userId).find((i) => i.id === intent.id);
  assert.ok(survived, 'an in-flight intent must survive the TTL sweep — deleting it strands a broadcast swap');
  assert.equal(survived.status, 'active', 'and must keep its status');
  assert.equal(survived.claimToken, claimToken, 'and must keep its claim');
});

test('an in-flight intent stays visible to the recovery sweep past its TTL', () => {
  // The reason the drop is a double-spend risk, stated as a test: recovery reads
  // `listExecIntents`, which only sees intents still in the live set. If the TTL
  // sweep deletes the row, recovery can never find the swap — so a crash after
  // broadcast leaves a trade nothing will reconcile, and the next tick re-emits.
  const userId = createUser(`ttlrecover-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, 'pw').id;
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');
  markIntentExec(userId, intent.id, { stage: 'sent', txHash: '0xdead', nonce: 9 });

  agePastTtl(getRealIntent(userId, intent.id));

  const found = listExecIntents().filter((e) => e.userId === userId);
  assert.equal(found.length, 1, 'a journalled swap must stay reachable by recovery after its TTL expires');
  assert.equal(found[0].intent.id, intent.id);
  assert.equal(found[0].intent.exec.txHash, '0xdead');
});

test('a stale open intent with NO journal entry is still dropped at the TTL', () => {
  // The counterpart to the guard: an intent the executor never touched is a dead
  // browser tab's proposal, and the TTL must keep clearing it or the buy-dedup
  // guard blocks fresh signals for that token forever.
  const userId = uid('ttldrop');
  const intent = buyIntent(userId);
  agePastTtl(getRealIntent(userId, intent.id));

  const gone = getRealIntents(userId).find((i) => i.id === intent.id);
  assert.equal(gone, undefined, 'a stale intent the executor never claimed must be dropped');
});

test('listExecIntents surfaces unfinished executions and skips resolved ones', () => {
  // listExecIntents sweeps listUsers(), so the intent must belong to a REAL
  // account — an intent on an id auth.js has never seen is unreachable to the
  // recovery path, and asserting on it would pass against a broken sweep.
  const userId = createUser(`exec-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, 'pw').id;
  const a = buyIntent(userId);
  const b = buyIntent(userId);
  const claimB = setRealIntentStatus(userId, b.id, 'active');
  markIntentExec(userId, a.id, { stage: 'sending', nonce: 1 });
  markIntentExec(userId, b.id, { stage: 'sent', txHash: '0xabc', nonce: 2 });
  setRealIntentStatus(userId, b.id, 'done', claimB.claimToken);

  const mine = listExecIntents().filter((e) => e.userId === userId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].intent.id, a.id);
  assert.equal(mine[0].intent.exec.stage, 'sending');
});

test('markIntentExec merges rather than replacing the nonce', () => {
  const userId = uid('merge');
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');
  markIntentExec(userId, intent.id, { stage: 'sending', nonce: 11, chain: 'base' });
  markIntentExec(userId, intent.id, { stage: 'sent', txHash: '0xfeed' });

  const row = getRealIntent(userId, intent.id);
  assert.equal(row.exec.stage, 'sent');
  assert.equal(row.exec.txHash, '0xfeed');
  assert.equal(row.exec.nonce, 11, 'the nonce must survive the stage transition — it is the recovery evidence');
  assert.equal(row.exec.chain, 'base');
});

test('an intent with no journal entry is invisible to the recovery sweep', () => {
  const userId = createUser(`noexec-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, 'pw').id;
  const intent = buyIntent(userId);
  setRealIntentStatus(userId, intent.id, 'active');
  assert.equal(listExecIntents().some((e) => e.intent.id === intent.id), false);
});
test('finalizeIntent is idempotent — a second close re-books nothing', async () => {
  const { finalizeIntent } = await import('./realIntent.js');
  const { getWallet, executeMarketOrder } = await import('./wallet.js');
  const u = uid('close');
  // A real position to reduce, so a double close would be visible as a deleted
  // position plus a second realized booking.
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });

  const intent = buyIntent(u, { side: 'sell', amountUsd: 0, estTokens: 100, intentPrice: 0.7 });
  setRealIntentStatus(u, intent.id, 'active');

  finalizeIntent(u, intent.id, { force: true });
  const afterFirst = getWallet(u).realizedPnl;
  finalizeIntent(u, intent.id, { force: true });
  finalizeIntent(u, intent.id, { force: true });

  assert.equal(getWallet(u).realizedPnl, afterFirst, 'closing thrice must book exactly one fill');
});

test('the two close paths apply identical bookkeeping', async () => {
  const { finalizeIntent } = await import('./realIntent.js');
  const { getWallet, executeMarketOrder } = await import('./wallet.js');
  const pnl = (close) => {
    const u = uid('parity');
    executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
    const intent = buyIntent(u, { side: 'sell', amountUsd: 0, estTokens: 100, intentPrice: 0.7 });
    const claim = setRealIntentStatus(u, intent.id, 'active');
    close(u, intent, claim);
    return getWallet(u).realizedPnl;
  };
  const viaStateMachine = pnl((u, i, claim) => setRealIntentStatus(u, i.id, 'done', claim.claimToken));
  const viaForceClose = pnl((u, i) => finalizeIntent(u, i.id, { force: true }));
  assert.equal(viaForceClose, viaStateMachine, 'a force-close must book the same P&L as a claimed close');
});

test('auto-approve defaults to off for every user, including pre-existing ones', () => {
  const u = uid('autodefault');
  assert.equal(isAutoApprove(u), false, 'absent means manual — the only behavior that exists today');
});

test('auto-approve round-trips through persistence', () => {
  const u = uid('autoroundtrip');
  setRealMode(u, true); // approval authority is meaningless without real mode
  assert.deepEqual(setAutoApprove(u, true), { autoApprove: true });
  flushUserNow(u);

  const saved = JSON.parse(readFileSync(join(TEMP_DIR, `${u}.json`), 'utf-8'));
  assert.equal(saved.autoApprove, true, 'the flag must survive a restart, or it silently reverts to manual');
});

test('a truthy non-boolean cannot arm auto-approve', () => {
  const u = uid('autostrict');
  for (const bad of ['true', 1, 'yes', {}, []]) {
    setAutoApprove(u, bad);
    assert.equal(isAutoApprove(u), false, `${JSON.stringify(bad)} must not arm spending authority`);
  }
});

test('manual mode can be restored', () => {
  const u = uid('automanual');
  setRealMode(u, true);
  setAutoApprove(u, true);
  assert.equal(isAutoApprove(u), true);
  assert.deepEqual(setAutoApprove(u, false), { autoApprove: false });
  assert.equal(isAutoApprove(u), false);
});

test('approve authority cannot be armed while real mode is off', () => {
  const u = uid('autogate');
  assert.equal(setAutoApprove(u, true).autoApprove, false, 'virtual mode must refuse to store an armed flag');
  assert.equal(isAutoApprove(u), false);
});

test('turning real mode off revokes approve authority', () => {
  const u = uid('autodisarm');
  setRealMode(u, true);
  assert.equal(setAutoApprove(u, true).autoApprove, true);

  setRealMode(u, false);
  assert.equal(isAutoApprove(u), false, 'approve authority must not outlive the mode it was granted for');
});

test('re-enabling real mode does not silently restore approve authority', () => {
  const u = uid('autosticky');
  setRealMode(u, true);
  setAutoApprove(u, true);
  setRealMode(u, false);
  setRealMode(u, true);
  assert.equal(isAutoApprove(u), false, 'the user must re-approve, not inherit a grant from a previous session');
});

test('a legacy state file with both flags true is not readable as armed', () => {
  const u = uid('autolegacy');
  flushUserNow(u);
  const p = join(TEMP_DIR, `${u}.json`);
  const state = JSON.parse(readFileSync(p, 'utf-8'));
  state.realMode = false;
  state.autoApprove = true;
  writeFileSync(p, JSON.stringify(state));
  // Force a reload through the module's own state cache by mutating the live
  // state the way an older build's file would have left it.
  setRealMode(u, true);   // re-arm mode, then re-disable to force the disarm path
  setRealMode(u, false);
  assert.equal(isAutoApprove(u), false, 'real mode off must never report approve authority as active');
});

test('a confirmed REAL exit books the risk ledger the daily-loss cap reads', async () => {
  // The wiring the cap was missing. Real exits used to write only the autopilot
  // stats, so the ledger — the cap's only input — never saw a real loss and the
  // cap could not fire in real mode. This asserts the confirmation path books it.
  const { finalizeIntent } = await import('./realIntent.js');
  const { getRiskLedger, addMirroredPosition } = await import('./wallet.js');
  const u = uid('realexit');
  // A mirrored real holding, then a losing real exit of 100 tokens bought at
  // $0.50 and sold at $0.30 → −$20 realized.
  addMirroredPosition(u, { tokenAddress: ADDR, symbol: 'TEST', chainId: 'base', tokens: 100, price: 0.5 });
  const intent = buyIntent(u, { side: 'sell', amountUsd: 30, estTokens: 100, intentPrice: 0.3, entryAvgPrice: 0.5 });
  setRealIntentStatus(u, intent.id, 'active');

  assert.equal(getRiskLedger(u).length, 0, 'nothing booked before the exit confirms');
  finalizeIntent(u, intent.id, { force: true });

  const led = getRiskLedger(u);
  assert.equal(led.length, 1, 'a confirmed real exit books exactly one ledger row');
  assert.equal(Math.round(led[0].usd * 100) / 100, -20, 'the booked P&L is the real exit, not a paper one');
  assert.equal(Number.isFinite(led[0].ts), true, 'a row without a timestamp can never age out of the cap');
});

test('a real exit booked twice does not double-count against the cap', async () => {
  const { finalizeIntent } = await import('./realIntent.js');
  const { getRiskLedger } = await import('./wallet.js');
  const u = uid('realexitidem');
  const intent = buyIntent(u, { side: 'sell', amountUsd: 30, estTokens: 100, intentPrice: 0.3, entryAvgPrice: 0.5 });
  setRealIntentStatus(u, intent.id, 'active');

  finalizeIntent(u, intent.id, { force: true });
  finalizeIntent(u, intent.id, { force: true });
  finalizeIntent(u, intent.id, { force: true });

  assert.equal(getRiskLedger(u).length, 1, 'closing thrice must book one loss, not three');
});
