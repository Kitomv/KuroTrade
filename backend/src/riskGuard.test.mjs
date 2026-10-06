import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluate, realizedInWindow, isDailyLossBreached, isKilled, LOSS_WINDOW_MS, LIMITS } from './riskGuard.js';

const NOW = 1_700_000_000_000;

/** A well-formed buy that passes every gate; override one field per test. */
function baseCtx(over = {}) {
  return {
    now: NOW,
    intent: { side: 'buy' },
    usdAmount: 20,
    balanceUsd: 100,
    gasReserveUsd: 1,
    token: { liquidityUsd: 5_000, fdv: 100_000, txns24h: { buys: 80, sells: 20 } },
    quote: {
      toAmountMin: 1,
      quotedAt: NOW - 1_000,
      gasLimit: 200_000,
      maxFeePerGas: 1,
      maxFeeCeilingGwei: 200,
      priceImpact: 0.005,
    },
    ...over,
  };
}

/**
 * A sell context. `now` MUST be passed explicitly: `evaluate` defaults it to
 * Date.now(), which against a fixed-NOW quote reads as a decade-old quote.
 */
function sellCtx(over = {}) {
  return { now: NOW, intent: { side: 'sell' }, usdAmount: 20, balanceUsd: 100, quote: baseCtx().quote, ...over };
}

test('passes a well-formed buy', () => {
  assert.equal(evaluate({ side: 'buy' }, baseCtx()).ok, true);
});

test('kill switch blocks buys and sells alike', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kill-'));
  try {
    writeFileSync(join(dir, 'KILL'), '');
    assert.equal(isKilled(dir), true);
    assert.equal(evaluate({ side: 'buy' }, baseCtx({ dataDir: dir })).code, 'killed');
    assert.equal(evaluate({ side: 'sell' }, baseCtx({ dataDir: dir })).code, 'killed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env kill switch works with no data dir', () => {
  const prev = process.env.REAL_EXECUTION_KILL;
  process.env.REAL_EXECUTION_KILL = '1';
  try {
    assert.equal(isKilled(null), true);
    assert.equal(evaluate({ side: 'buy' }, baseCtx()).code, 'killed');
  } finally {
    if (prev === undefined) delete process.env.REAL_EXECUTION_KILL;
    else process.env.REAL_EXECUTION_KILL = prev;
  }
});

test('per-trade cap: exactly at the limit passes, one cent over fails', () => {
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ usdAmount: LIMITS.maxUsdPerTrade })).ok, true);
  const over = evaluate({ side: 'buy' }, baseCtx({ usdAmount: LIMITS.maxUsdPerTrade + 0.01 }));
  assert.equal(over.code, 'over_cap');
});

test('sell is exempt from the per-trade cap but still needs a valid amount', () => {
  assert.equal(evaluate({ side: 'sell' }, sellCtx({ usdAmount: 5_000 })).ok, true);
  assert.equal(evaluate({ side: 'sell' }, sellCtx({ usdAmount: 0 })).code, 'bad_amount');
});

test('daily loss cap blocks buys and never sells', () => {
  const ledger = [{ ts: NOW - 1_000, usd: -30 }];
  assert.equal(isDailyLossBreached(ledger, NOW, 25), true);
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ ledger })).code, 'daily_loss');
  assert.equal(evaluate({ side: 'sell' }, sellCtx({ ledger })).ok, true);
});

test('daily loss cap boundary: a loss ages out at exactly the window', () => {
  const atEdge = [{ ts: NOW - LOSS_WINDOW_MS, usd: -30 }];
  const justInside = [{ ts: NOW - LOSS_WINDOW_MS + 1_000, usd: -30 }];
  assert.equal(isDailyLossBreached(atEdge, NOW, 25), false, 'exactly 24h must age out');
  assert.equal(isDailyLossBreached(justInside, NOW, 25), true, '24h minus one second must still count');
});

test('a loss under the cap does not block buys', () => {
  const ledger = [{ ts: NOW - 1_000, usd: -24.99 }];
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ ledger })).ok, true);
});

test('ledger entries with an unreadable timestamp count against the cap', () => {
  assert.equal(isDailyLossBreached([{ ts: 'nope', usd: -30 }], NOW, 25), true);
  assert.equal(Number.isFinite(realizedInWindow(null, NOW)), true);
  assert.equal(realizedInWindow(null, NOW), 0);
});

test('thin liquidity: 20x exactly passes, one dollar under fails', () => {
  const market = { fdv: 0, txns24h: { buys: 80, sells: 20 } };
  const exact = baseCtx({ token: { liquidityUsd: 400, ...market } });
  assert.equal(evaluate({ side: 'buy' }, exact).ok, true);
  const under = baseCtx({ token: { liquidityUsd: 399, ...market } });
  assert.equal(evaluate({ side: 'buy' }, under).code, 'thin_liquidity');
});

test('honeypot: sell ratio at the floor passes, below it fails', () => {
  const ok = baseCtx({ token: { liquidityUsd: 5_000, fdv: 0, txns24h: { buys: 80, sells: 20 } } });
  assert.equal(evaluate({ side: 'buy' }, ok).ok, true);
  const trap = baseCtx({ token: { liquidityUsd: 5_000, fdv: 0, txns24h: { buys: 99, sells: 1 } } });
  assert.equal(evaluate({ side: 'buy' }, trap).code, 'honeypot');
});

test('missing market data fails closed rather than passing', () => {
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ token: { liquidityUsd: 5_000, txns24h: { buys: 0, sells: 0 } } })).code, 'no_market_data');
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ token: { liquidityUsd: 'x', txns24h: { buys: 5, sells: 5 } } })).code, 'thin_liquidity');
});

test('thin float: FDV far above liquidity is rejected', () => {
  const trap = baseCtx({ token: { liquidityUsd: 5_000, fdv: 5_000_000, txns24h: { buys: 50, sells: 50 } } });
  assert.equal(evaluate({ side: 'buy' }, trap).code, 'thin_float');
});

test('token quality gates do not apply to a sell', () => {
  const sell = sellCtx({
    token: { liquidityUsd: 1, fdv: 9_999_999, txns24h: { buys: 999, sells: 1 } },
  });
  assert.equal(evaluate({ side: 'sell' }, sell).ok, true);
});

test('zero minAmountOut is refused — the classic drain', () => {
  for (const bad of [0, -1, null, undefined, 'x']) {
    const r = evaluate({ side: 'buy' }, baseCtx({ quote: { ...baseCtx().quote, toAmountMin: bad } }));
    assert.equal(r.code, 'no_min_out', `toAmountMin=${bad} must be refused`);
  }
});

test('quote freshness: over the limit is refused, under passes', () => {
  const stale = baseCtx({ quote: { ...baseCtx().quote, quotedAt: NOW - LIMITS.maxQuoteAgeMs - 1 } });
  assert.equal(evaluate({ side: 'buy' }, stale).code, 'stale_quote');
  const fresh = baseCtx({ quote: { ...baseCtx().quote, quotedAt: NOW - LIMITS.maxQuoteAgeMs } });
  assert.equal(evaluate({ side: 'buy' }, fresh).ok, true);
});

test('end-to-end budget is measured from the claim', () => {
  const slow = baseCtx({ startedAt: NOW - LIMITS.maxEndToEndMs - 1 });
  assert.equal(evaluate({ side: 'buy' }, slow).code, 'too_slow');
});

test('gas ceiling: exactly at the limit passes, one over fails', () => {
  const at = baseCtx({ quote: { ...baseCtx().quote, gasLimit: LIMITS.maxGasLimit } });
  assert.equal(evaluate({ side: 'buy' }, at).ok, true);
  const over = baseCtx({ quote: { ...baseCtx().quote, gasLimit: LIMITS.maxGasLimit + 1 } });
  assert.equal(evaluate({ side: 'buy' }, over).code, 'gas_ceiling');
});

test('gas price above the chain ceiling is refused', () => {
  const hot = baseCtx({ quote: { ...baseCtx().quote, maxFeePerGas: 250 } });
  assert.equal(evaluate({ side: 'buy' }, hot).code, 'gas_price');
});

test('slippage echoed above the cap is refused', () => {
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ slippages: LIMITS.maxSlippage })).ok, true);
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ slippages: 0.05 })).code, 'slippage');
});

test('price impact: exactly at the cap passes, one over fails', () => {
  const at = baseCtx({ quote: { ...baseCtx().quote, priceImpact: LIMITS.maxPriceImpact } });
  assert.equal(evaluate({ side: 'buy' }, at).ok, true);
  const over = baseCtx({ quote: { ...baseCtx().quote, priceImpact: LIMITS.maxPriceImpact + 0.001 } });
  assert.equal(evaluate({ side: 'buy' }, over).code, 'price_impact');
});

test('insufficient balance accounts for the gas reserve', () => {
  const tight = baseCtx({ usdAmount: 20, balanceUsd: 20.5, gasReserveUsd: 1 });
  assert.equal(evaluate({ side: 'buy' }, tight).code, 'insufficient');
  const exact = baseCtx({ usdAmount: 20, balanceUsd: 21, gasReserveUsd: 1 });
  assert.equal(evaluate({ side: 'buy' }, exact).ok, true);
});

test('a missing quote is a refusal, not a pass', () => {
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ quote: null })).code, 'no_quote');
});

test('garbage input never passes', () => {
  assert.equal(evaluate(null, {}).code, 'bad_amount');
  assert.equal(evaluate({ side: 'hodl' }, baseCtx()).code, 'bad_side');
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ usdAmount: NaN })).code, 'bad_amount');
  assert.equal(evaluate({ side: 'buy' }, baseCtx({ balanceUsd: 'x' })).code, 'bad_balance');
});

test('an unreadable balance fails closed on a sell too', () => {
  assert.equal(evaluate({ side: 'sell' }, sellCtx({ balanceUsd: 'x' })).code, 'bad_balance');
});