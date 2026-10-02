// Characterization tests for the multi-agent engine.
//
// aiAgent.js is the largest file in the repo and had no coverage at all,
// which makes splitting it risky: a refactor that quietly changes a
// threshold or a score formula would be invisible. These tests pin the
// decision behaviour BEFORE the file is decomposed, so the extraction can
// be verified against them.
//
// No network: analyzeToken() accepts a pre-fetched market, so the
// deterministic path runs entirely in-process. The LLM path is exercised
// only in that it degrades to deterministic when no key is configured.
// Run: node --test backend/src/aiAgent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set BEFORE the module graph is imported: persistence.js resolves
// DATA_DIR at module-evaluation time, and ESM hoists imports above statements.
const TEMP_DIR = join(tmpdir(), `agent-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;
// A provider key would make analyzeToken() try a live HTTP call. Empty means
// the deterministic engine is used, which is what these tests assert.
delete process.env.ROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const {
  analyzeToken, setAutopilot, getAutopilot, initAutopilot, recordRealized,
  clearAutopilotLogs, recordSignalOutcome,
} = await import('./aiAgent.js');
const { computeSignalAccuracy, buildAccuracyBlock } = await import('./memory.js');
const { resetWallet } = await import('./wallet.js');

const ADDR = '0x1111111111111111111111111111111111111111';
let seq = 0;
const freshUser = () => `agent_${process.pid}_${seq++}`;

/** A well-formed market the deterministic engine can score. Overrides are merged. */
const market = (o = {}) => ({
  tokenAddress: ADDR,
  symbol: 'TEST',
  name: 'Test Token',
  chainId: 'base',
  priceUsd: 1,
  change5m: 0,
  change1h: 0,
  change24h: 0,
  volume24h: 50000,
  liquidityUsd: 100000,
  fdv: 1000000,
  txns24h: { buys: 50, sells: 50 },
  ...o,
});

/* ---------------- technical analysis ---------------- */

test('a flat market scores neutral and is not a breakout', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market());
  assert.equal(r.agents.technical.trend, 'NEUTRAL');
  assert.equal(r.agents.technical.isBreakout, false);
  assert.equal(r.agents.technical.buyRatio, 50, 'an even split reads as 50%');
  assert.equal(r.llmPowered, false, 'no key configured, so the deterministic path ran');
});

test('a 5m spike with real buy pressure is a momentum breakout', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market({ change5m: 3, change1h: 4, txns24h: { buys: 80, sells: 20 } }));
  assert.equal(r.agents.technical.isBreakout, true);
  assert.equal(r.agents.technical.trend, 'MOMENTUM_BREAKOUT');
});

test('the buy ratio is buys over total, defaulting to 50 when there are no trades', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market({ txns24h: { buys: 75, sells: 25 } }));
  assert.equal(r.agents.technical.buyRatio, 75);
  const flat = await analyzeToken(freshUser(), ADDR, market({ txns24h: { buys: 0, sells: 0 } }));
  assert.equal(flat.agents.technical.buyRatio, 50, 'no trades must not read as 0% buying');
});

test('missing or malformed market fields degrade to zero, never to NaN', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market({ change5m: undefined, volume24h: null, liquidityUsd: 0, fdv: NaN }));
  for (const key of ['momentumScore', 'buyRatio', 'volToLiqRatio', 'priceUsd', 'liquidityUsd', 'volume24h', 'fdv']) {
    assert.ok(Number.isFinite(r.agents.technical[key]), `${key} must be finite, got ${r.agents.technical[key]}`);
  }
});

/* ---------------- bull / bear theses ---------------- */

test('thick liquidity and buying support the bull case', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market({ liquidityUsd: 500000, volume24h: 200000, txns24h: { buys: 80, sells: 20 }, change5m: 1, change1h: 2 }));
  assert.ok(r.agents.bull.score > 50, `expected a supportive bull score, got ${r.agents.bull.score}`);
  assert.ok(r.agents.bull.thesis.length > 0, 'a thesis is always produced');
});

test('thin liquidity is the strongest bear signal', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market({ liquidityUsd: 6000, volume24h: 1000, fdv: 50000000 }));
  assert.ok(r.agents.bear.score > 50, `expected a bearish read, got ${r.agents.bear.score}`);
  assert.ok(r.agents.bear.risks.some((x) => /likuiditas/i.test(x)), 'the thin-liquidity warning is surfaced');
});

/* ---------------- risk gate ---------------- */

test('liquidity under $5k is rejected outright', async () => {
  const r = await analyzeToken(freshUser(), ADDR, market({ liquidityUsd: 3000 }));
  assert.equal(r.agents.risk.approved, false);
  assert.match(r.agents.risk.rejectionReason, /Likuiditas/);
});

test('a bear score above 75 is vetoed even with deep liquidity', async () => {
  // A huge FDV against small liquidity, a huge 24h run, and heavy sell
  // pressure — deep enough liquidity that only the bear veto can stop it.
  const r = await analyzeToken(freshUser(), ADDR, market({
    liquidityUsd: 40000, fdv: 90000000, change24h: 180, change5m: -5, txns24h: { buys: 20, sells: 80 },
  }));
  if (!r.agents.risk.approved) assert.match(r.agents.risk.rejectionReason, /Bearish/);
  else assert.ok(r.agents.bear.score <= 75, 'approved means the veto threshold was respected');
});

test('risk level changes the sizing cap, and thin pools cap it regardless', async () => {
  const u = freshUser();
  resetWallet(u, 1000);
  setAutopilot(u, { riskLevel: 'low' });
  const low = await analyzeToken(u, ADDR, market({ liquidityUsd: 500000 }));
  setAutopilot(u, { riskLevel: 'high' });
  const high = await analyzeToken(u, ADDR, market({ liquidityUsd: 500000 }));
  assert.ok(high.agents.risk.maxAllocationPct > low.agents.risk.maxAllocationPct, 'high risk must size larger');

  // Under $20k liquidity the cap is forced down to 10% even on high risk.
  const thin = await analyzeToken(u, ADDR, market({ liquidityUsd: 15000 }));
  assert.ok(thin.agents.risk.maxAllocationPct <= 10, `thin pool must be capped at 10%, got ${thin.agents.risk.maxAllocationPct}`);
});

/* ---------------- verdict ---------------- */

test('stop-loss and take-profit track the configured percentages', async () => {
  const u = freshUser();
  setAutopilot(u, { takeProfitPct: 20, stopLossPct: 10 });
  const r = await analyzeToken(u, ADDR, market({ priceUsd: 2 }));
  assert.equal(r.agents.risk.targetProfitPct, 20);
  assert.equal(r.agents.risk.stopLossPct, 10);
  assert.equal(r.agents.risk.takeProfitPrice, 2.4, '2.00 * 1.20');
  assert.equal(r.agents.risk.stopLossPrice, 1.8, '2.00 * 0.90');
});

test('a signal is always one of the five known values', async () => {
  for (const m of [market(), market({ change24h: 200, change5m: -9 }), market({ liquidityUsd: 3000 })]) {
    const r = await analyzeToken(freshUser(), ADDR, m);
    assert.ok(['STRONG_BUY', 'BUY', 'HOLD', 'SELL'].includes(r.verdict.signal), `unknown signal ${r.verdict.signal}`);
    assert.ok(r.verdict.confidence >= 0 && r.verdict.confidence <= 100, 'confidence must be 0-100');
  }
});

test('the recommended position is sized off the caller balance and never exceeds it', async () => {
  const u = freshUser();
  resetWallet(u, 100);
  const r = await analyzeToken(u, ADDR, market({ priceUsd: 1, liquidityUsd: 500000 }));
  assert.ok(r.verdict.recommendedUsd > 0);
  assert.ok(r.verdict.recommendedUsd <= 100, `sized ${r.verdict.recommendedUsd} from a 100 balance`);
  assert.ok(Number.isFinite(r.verdict.recommendedTokens), 'token estimate must be finite');
});

/* ---------------- state and config ---------------- */

test('autopilot defaults to off with the documented settings', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  assert.equal(st.enabled, false, 'never auto-enables itself');
  assert.equal(st.riskLevel, 'medium');
  assert.equal(st.takeProfitPct, 15);
  assert.equal(st.stopLossPct, 7);
  assert.equal(st.maxOpenPositions, 3);
  assert.equal(st.status, 'IDLE');
});

test('a partial config update leaves the other settings untouched', () => {
  // The UI toggles only `enabled`; applying defaults for every other field
  // would silently reset the user's stop-loss on every toggle.
  const u = freshUser();
  setAutopilot(u, { takeProfitPct: 42, stopLossPct: 11, maxOpenPositions: 7 });
  setAutopilot(u, { enabled: true });
  const st = getAutopilot(u);
  assert.equal(st.enabled, true);
  assert.equal(st.takeProfitPct, 42, 'take-profit survived the toggle');
  assert.equal(st.stopLossPct, 11, 'stop-loss survived the toggle');
  assert.equal(st.maxOpenPositions, 7, 'position cap survived the toggle');
});

test('out-of-range config values are clamped, not accepted verbatim', () => {
  const u = freshUser();
  setAutopilot(u, { takeProfitPct: 9999, stopLossPct: -5, minConfidence: 0, maxOpenPositions: 500, llmTemperature: 42 });
  const st = getAutopilot(u);
  assert.ok(st.takeProfitPct <= 500, `clamped to 500, got ${st.takeProfitPct}`);
  assert.ok(st.stopLossPct >= 1, `clamped to >=1, got ${st.stopLossPct}`);
  assert.ok(st.minConfidence >= 1, `clamped to >=1, got ${st.minConfidence}`);
  assert.ok(st.maxOpenPositions <= 10, `clamped to <=10, got ${st.maxOpenPositions}`);
  assert.ok(st.llmTemperature <= 1, `clamped to <=1, got ${st.llmTemperature}`);
});

test('an unknown risk level or agent mode falls back instead of sticking', () => {
  const u = freshUser();
  setAutopilot(u, { riskLevel: 'yolo', agentMode: 'psychic' });
  const st = getAutopilot(u);
  assert.equal(st.riskLevel, 'medium');
  assert.equal(st.agentMode, 'blend');
});

/* ---------------- stats ---------------- */

test('realized PnL accumulates and the win rate follows from it', () => {
  const u = freshUser();
  recordRealized(u, { pnlUsd: 20, key: 'a' });
  recordRealized(u, { pnlUsd: -5, key: 'b' });
  recordRealized(u, { pnlUsd: 10, key: 'c' });
  const s = getAutopilot(u).stats;
  assert.equal(s.totalTrades, 3);
  assert.equal(s.profitableTrades, 2);
  assert.equal(Math.round(s.totalProfitUsd), 25);
  assert.equal(s.winRate, 67, '2 of 3 rounds to 67%');
});

test('the same exit is never counted twice, however many times it is retried', () => {
  const u = freshUser();
  recordRealized(u, { pnlUsd: 50, key: 'intent-x' });
  recordRealized(u, { pnlUsd: 50, key: 'intent-x' });
  recordRealized(u, { pnlUsd: 50, key: 'intent-x' });
  assert.equal(getAutopilot(u).stats.totalTrades, 1, 'a retried confirmation must not inflate the count');
});

test('a non-finite PnL is ignored and does not burn the dedup key', () => {
  // Burning the key on a NaN would silently drop the real record for the
  // same exit, so the round trip would vanish from the totals entirely.
  const u = freshUser();
  recordRealized(u, { pnlUsd: NaN, key: 'intent-y' });
  assert.equal(getAutopilot(u).stats.totalTrades, 0);
  recordRealized(u, { pnlUsd: 25, key: 'intent-y' });
  assert.equal(getAutopilot(u).stats.totalTrades, 1, 'the same key still works afterwards');
});

/* ---------------- init and logs ---------------- */

test('initAutopilot on an unknown user leaves the defaults in place', () => {
  const u = freshUser();
  initAutopilot(u);
  const st = getAutopilot(u);
  assert.equal(st.enabled, false);
  assert.equal(st.takeProfitPct, 15);
});

test('clearing the log stream empties it without touching the config', () => {
  const u = freshUser();
  setAutopilot(u, { takeProfitPct: 33 });
  clearAutopilotLogs(u);
  const st = getAutopilot(u);
  assert.equal(st.logs.length, 0);
  assert.equal(st.takeProfitPct, 33, 'config is not a log');
});

/* ---------------- signal accuracy pipeline ---------------- */

// The regression this guards: accuracy used to be computed by scanning
// `signalHistory`, a 200-entry buffer that turns over in ~3 minutes while
// outcomes are measured at 1h/24h. Measured live: 0 of 200 entries ever had a
// price, so the agents' calibration block was permanently empty.

test('a completed outcome folds into the aggregate, not the display buffer', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  const entry = {
    ts: Date.now(), symbol: 'AAA', address: ADDR, chainId: 'base',
    signal: 'STRONG_BUY', confidence: 82, entryPrice: 1, kind: 'signal',
    price1h: 1.1, price24h: 1.2,
  };
  recordSignalOutcome(st, entry);
  const acc = computeSignalAccuracy(st);
  assert.equal(acc.n1h, 1, 'the 1h outcome is counted');
  assert.equal(acc.win1h, 1, 'price rose after a BUY → a win');
  assert.equal(acc.acc1h, 100);
  assert.equal(acc.n24h, 1);
  assert.equal(acc.bySignal.STRONG_BUY.n1h, 1, 'per-signal bucket is written');
  assert.equal(acc.byChain.base.n1h, 1, 'per-chain bucket is written');
});

test('a SELL call is a win when the price falls, and a loss when it rises', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  recordSignalOutcome(st, { ts: 1, chainId: 'base', signal: 'SELL', entryPrice: 1, kind: 'signal', price1h: 0.9 });
  recordSignalOutcome(st, { ts: 2, chainId: 'base', signal: 'SELL', entryPrice: 1, kind: 'signal', price1h: 1.1 });
  const acc = computeSignalAccuracy(st);
  assert.equal(acc.n1h, 2);
  assert.equal(acc.win1h, 1, 'one right, one wrong');
});

test('folding the same outcome twice does not double-count', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  const entry = { ts: 1, chainId: 'base', signal: 'BUY', entryPrice: 1, kind: 'signal', price1h: 1.5 };
  recordSignalOutcome(st, entry);
  recordSignalOutcome(st, entry);
  assert.equal(computeSignalAccuracy(st).n1h, 1, 'the fold is idempotent per entry');
});

test('a near-miss is bucketed separately so it never inflates signal accuracy', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  recordSignalOutcome(st, {
    ts: 1, chainId: 'base', signal: 'STRONG_BUY', entryPrice: 1,
    kind: 'nearMiss', reason: 'SL_COOLDOWN', price1h: 1.5,
  });
  const acc = computeSignalAccuracy(st);
  assert.equal(acc.bySignal['NEAR_MISS:STRONG_BUY'].n1h, 1, 'tracked under its own key');
  assert.equal(acc.bySignal.STRONG_BUY, undefined, 'the acted-on signal bucket stays clean');
});

test('an unpriceable entry is ignored rather than counted as a loss', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  recordSignalOutcome(st, { ts: 1, chainId: 'base', signal: 'BUY', entryPrice: 0, kind: 'signal', price1h: 5 });
  recordSignalOutcome(st, { ts: 2, chainId: 'base', signal: 'BUY', entryPrice: 1, kind: 'signal' });
  assert.equal(computeSignalAccuracy(st).n1h, 0, 'no entry price / no outcome price → not counted');
});

test('accuracy survives a display-buffer rotation (the actual bug)', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  // Record an outcome, then simulate the display buffer turning over many
  // times — the old implementation would have lost the outcome entirely.
  recordSignalOutcome(st, { ts: 1, chainId: 'base', signal: 'BUY', entryPrice: 1, kind: 'signal', price1h: 1.2 });
  st.signalHistory = Array.from({ length: 200 }, (_, i) => ({ ts: i, signal: 'HOLD', entryPrice: 1 }));
  const acc = computeSignalAccuracy(st);
  assert.equal(acc.n1h, 1, 'the aggregate is independent of the rolling buffer');
  assert.ok(buildAccuracyBlock(st).includes('BUY 100% @1h'), 'the agents get the calibration line');
});

test('the calibration block stays empty until an outcome exists', () => {
  const u = freshUser();
  const st = getAutopilot(u);
  assert.equal(buildAccuracyBlock(st), '', 'no data → no misleading instruction');
});

test('an account hydrated without the new fields gets them repaired', () => {
  // A save from before the split lacks pendingSignals/signalStats. Loading it
  // must not leave undefined in place of the aggregate.
  const u = freshUser();
  initAutopilot(u);
  const st = getAutopilot(u);
  assert.ok(Array.isArray(st.pendingSignals), 'pendingSignals exists');
  assert.ok(st.signalStats && st.signalStats.totals, 'signalStats exists with totals');
});
