// The buy-path risk gate. riskGuard.js holds the policy and has its own tests;
// this file pins the WIRING, which is the part that was missing: a policy that
// nothing calls protects nothing, and the call site lives inside the buy path
// where a unit test cannot reach it without a full scan harness.
//
// These tests therefore drive `evaluateBuyGate` directly — the exact function
// the scout and the manual-intent endpoint call — and assert the behaviour a
// real buy must see: the daily-loss cap fires on REAL losses, and the token
// quality gates refuse junk before an intent is ever created.
//
// Run: node --test src/buyGate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set BEFORE the module graph is imported — persistence.js resolves
// DATA_DIR at module-evaluation time. Without this the tests would write real
// user state into backend/data.
const TEMP_DIR = join(tmpdir(), `buygate-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const { evaluateBuyGate } = await import('./buyGate.js');
const { bookRiskLedger, getRiskLedger } = await import('./wallet.js');
const { LIMITS } = await import('./riskGuard.js');

let seq = 0;
const freshUser = () => `gate_${process.pid}_${seq++}`;

/** Explicit limits so the assertions do not depend on the operator's env. */
const LIMITS_FIXED = { ...LIMITS, maxUsdPerTrade: 50, maxDailyLossUsd: 25 };

/** A token that passes every quality gate. */
const goodToken = () => ({ liquidityUsd: 500_000, fdv: 1_000_000, txns24h: { buys: 80, sells: 20 } });

test('a clean buy passes the pre-quote gate', () => {
  const gate = evaluateBuyGate({ userId: freshUser(), usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED });
  assert.equal(gate.ok, true, gate.message ?? '');
});

test('a REAL loss booked into the ledger blocks the next buy', () => {
  // The gap this closes: real exits wrote nothing to the ledger, so the cap
  // never saw a real loss. bookRiskLedger is the path a confirmed real exit
  // now uses.
  const u = freshUser();
  bookRiskLedger(u, -30); // beyond the $25 default cap
  const gate = evaluateBuyGate({ userId: u, usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'daily_loss');
});

test('a loss below the cap still allows a buy', () => {
  const u = freshUser();
  bookRiskLedger(u, -10);
  const gate = evaluateBuyGate({ userId: u, usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED });
  assert.equal(gate.ok, true, gate.message ?? '');
});

test('the cap never blocks a SELL — a stop-loss must always be able to exit', () => {
  const u = freshUser();
  bookRiskLedger(u, -10_000);
  const gate = evaluateBuyGate({ userId: u, side: 'sell', usdAmount: 10, limits: LIMITS_FIXED });
  assert.equal(gate.ok, true, gate.message ?? '');
});

test('a freshly booked loss is visible to the very next gate call', () => {
  // Guards against a stale-cache wiring bug: the gate must read the ledger at
  // call time, not a snapshot captured at import.
  const u = freshUser();
  assert.equal(evaluateBuyGate({ userId: u, usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED }).ok, true);
  bookRiskLedger(u, -100);
  assert.equal(evaluateBuyGate({ userId: u, usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED }).code, 'daily_loss');
  assert.equal(getRiskLedger(u).length, 1);
});

test('thin liquidity is refused before an intent can be created', () => {
  const gate = evaluateBuyGate({
    userId: freshUser(), usdAmount: 10,
    token: { liquidityUsd: 100, fdv: 0, txns24h: { buys: 80, sells: 20 } },
    limits: LIMITS_FIXED,
  });
  assert.equal(gate.code, 'thin_liquidity');
});

test('a honeypot sell ratio is refused', () => {
  const gate = evaluateBuyGate({
    userId: freshUser(), usdAmount: 10,
    token: { liquidityUsd: 500_000, fdv: 0, txns24h: { buys: 99, sells: 1 } },
    limits: LIMITS_FIXED,
  });
  assert.equal(gate.code, 'honeypot');
});

test('a thin-float profile is refused', () => {
  const gate = evaluateBuyGate({
    userId: freshUser(), usdAmount: 10,
    token: { liquidityUsd: 500_000, fdv: 1_000_000_000, txns24h: { buys: 50, sells: 50 } },
    limits: LIMITS_FIXED,
  });
  assert.equal(gate.code, 'thin_float');
});

test('the per-trade cap gates the intent emitter too', () => {
  const at = evaluateBuyGate({ userId: freshUser(), usdAmount: 50, token: goodToken(), limits: LIMITS_FIXED });
  assert.equal(at.ok, true, at.message ?? '');
  const over = evaluateBuyGate({ userId: freshUser(), usdAmount: 50.01, token: goodToken(), limits: LIMITS_FIXED });
  assert.equal(over.code, 'over_cap');
});

test('the kill switch stops buys even with a clean ledger', () => {
  const prev = process.env.REAL_EXECUTION_KILL;
  process.env.REAL_EXECUTION_KILL = '1';
  try {
    const gate = evaluateBuyGate({ userId: freshUser(), usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED });
    assert.equal(gate.code, 'killed');
  } finally {
    if (prev === undefined) delete process.env.REAL_EXECUTION_KILL;
    else process.env.REAL_EXECUTION_KILL = prev;
  }
});

test('a malformed amount is refused rather than passed', () => {
  for (const bad of [0, -1, NaN, 'x', null]) {
    const gate = evaluateBuyGate({ userId: freshUser(), usdAmount: bad, token: goodToken(), limits: LIMITS_FIXED });
    assert.equal(gate.code, 'bad_amount', `usdAmount=${bad} must be refused`);
  }
});

test('no userId means no ledger, and the token gates still apply', () => {
  const gate = evaluateBuyGate({ userId: null, usdAmount: 10, token: goodToken(), limits: LIMITS_FIXED });
  assert.equal(gate.ok, true, gate.message ?? '');
  const junk = evaluateBuyGate({ userId: null, usdAmount: 10, token: { liquidityUsd: 1, txns24h: { buys: 9, sells: 1 } }, limits: LIMITS_FIXED });
  assert.equal(junk.code, 'thin_liquidity');
});
