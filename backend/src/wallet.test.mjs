// Money-path tests for the virtual ledger. Every function here moves a number
// the user will read as their balance, and none of it was covered before —
// the intent state machine had tests, the arithmetic that produces it did not.
//
// These assert invariants, not implementation: balance never goes negative,
// a sell can never exceed what is held, reservations are respected by market
// orders, and an absurd upstream price can never fill an order.
// Run: node --test backend/src/wallet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set BEFORE the module graph is imported: persistence.js reads
// DATA_DIR at module-evaluation time, and ESM hoists imports above statements.
// Without this the tests would read and write real user state in backend/data.
const TEMP_DIR = join(tmpdir(), `wallet-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const {
  executeMarketOrder, createLimitOrder, cancelOrder, checkLimitOrders,
  getWallet, getPositions, getOrders, initWallet, resetWallet,
  updatePositionPrices, addMirroredPosition, reducePositionAmount, getRiskLedger,
} = await import('./wallet.js');
const { flushAll } = await import('./persistence.js');

const ADDR = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
let seq = 0;
/** Fresh user per test — the ledger is keyed by userId in a module-level Map. */
const freshUser = () => `w_test_${process.pid}_${seq++}`;

/** Assert two money values match to the cent, not to the last float bit. */
const assertMoney = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 0.005, `${msg}: expected ~${expected}, got ${actual}`);

/* ---------------- market buy / sell ---------------- */

test('a market buy debits exactly the cost and opens a position at the fill price', () => {
  const u = freshUser();
  const order = executeMarketOrder(u, {
    side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST',
    usdAmount: 50, tokenAmount: 0, currentPrice: 0.5,
  });

  // $50 at $0.50 = 100 tokens.
  assert.equal(order.amount, 100);
  assertMoney(getWallet(u).balance, 50, 'balance after a $50 buy');
  const [pos] = getPositions(u);
  assert.equal(pos.amount, 100);
  assertMoney(pos.avgBuyPrice, 0.5, 'entry price');
  assertMoney(pos.totalCost, 50, 'cost basis');
});

test('a second buy averages into one position rather than overwriting it', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.25 });

  const [pos] = getPositions(u);
  // 100 tokens @ $0.50 + 200 tokens @ $0.25 = 300 tokens, $100 cost.
  assert.equal(pos.amount, 300);
  assertMoney(pos.avgBuyPrice, 100 / 300, 'averaged entry');
  assertMoney(getWallet(u).balance, 0, 'both buys consumed the full balance');
});

test('a market sell credits proceeds, books realized PnL, and drops a fully-closed position', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  const sell = executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });

  // 100 tokens at $0.70 = $70 proceeds on a $50 basis.
  assert.equal(sell.amount, 100, 'the SELL order must record a real token amount');
  assertMoney(getOrders(u)[0].amount, 100, 'order survives sanitisation');
  assertMoney(getWallet(u).balance, 120, 'balance after the round trip');
  assertMoney(getWallet(u).realizedPnl, 20, 'realized profit');
  assert.equal(getPositions(u).length, 0, 'a fully-closed position is removed');
});

test('a partial sell leaves the remainder with a reduced cost basis, not a reduced entry', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 40, currentPrice: 0.7 });

  const [pos] = getPositions(u);
  assert.equal(pos.amount, 60);
  assertMoney(pos.avgBuyPrice, 0.5, 'entry price must not move on exit');
  assertMoney(pos.totalCost, 30, 'cost basis scales down with the tokens left');
  assertMoney(getWallet(u).realizedPnl, 8, 'realized PnL on the 40 tokens sold');
});

test('a sell larger than the position is rejected instead of going short', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });

  assert.throws(
    () => executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 999, currentPrice: 0.7 }),
    /tidak valid/,
  );
  assert.equal(getPositions(u)[0].amount, 100, 'a rejected sell must not touch the position');
  assertMoney(getWallet(u).balance, 50, 'a rejected sell must not credit proceeds');
});

test('selling a token that is not held is rejected', () => {
  const u = freshUser();
  assert.throws(
    () => executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 1, currentPrice: 0.7 }),
    /Tidak ada posisi/,
  );
});

/* ---------------- reservations ---------------- */

test('an open buy limit reserves its USD so a market buy cannot spend it twice', () => {
  const u = freshUser();
  createLimitOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 0.4, usdAmount: 60, tokenAmount: 150 });

  const w = getWallet(u);
  assertMoney(w.reservedUsd, 60, 'reserved for the open limit');
  assertMoney(w.available, 40, 'only the unreserved part is spendable');
  assertMoney(w.balance, 100, 'a limit order reserves, it does not debit');

  // $50 + $60 already reserved > $100 on hand.
  assert.throws(
    () => executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 }),
    /Saldo tidak cukup/,
  );
});

test('cancelling a limit releases its reservation', () => {
  const u = freshUser();
  const order = createLimitOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 0.4, usdAmount: 60, tokenAmount: 150 });
  assertMoney(getWallet(u).available, 40, 'reserved while open');

  cancelOrder(u, order.id);
  assertMoney(getWallet(u).available, 100, 'released on cancel');
  assert.equal(getOrders(u).find((o) => o.id === order.id).status, 'cancelled');
});

test('an open sell limit reserves its tokens so a market sell cannot oversell', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  createLimitOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 1.0, usdAmount: 60, tokenAmount: 60 });

  // 100 held, 60 reserved, so 40 is genuinely sellable.
  assert.throws(
    () => executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 50, currentPrice: 0.7 }),
    /melebihi posisi yang tersedia/,
  );
});

test('a sell limit larger than the holding is rejected at creation', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });

  assert.throws(
    () => createLimitOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 1.0, usdAmount: 150, tokenAmount: 150 }),
    /melebihi posisi/,
  );
});

test('a buy limit beyond the balance is rejected at creation', () => {
  const u = freshUser();
  assert.throws(
    () => createLimitOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 0.4, usdAmount: 500, tokenAmount: 1250 }),
    /Saldo tidak cukup/,
  );
});

/* ---------------- limit fills ---------------- */

test('a buy limit fills at or below its target and derives tokens from the fill price', () => {
  const u = freshUser();
  createLimitOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 0.4, usdAmount: 20, tokenAmount: 50 });

  // Not yet: 0.45 is above the 0.4 target.
  assert.equal(checkLimitOrders(u, new Map([[ADDR, 0.45]])).length, 0);

  // Target hit exactly — a limit fills on equality, not only below it.
  const filled = checkLimitOrders(u, new Map([[ADDR, 0.4]]));
  assert.equal(filled.length, 1);
  const [pos] = getPositions(u);
  assert.equal(pos.amount, 50, '$20 at $0.40 = 50 tokens');
  assertMoney(getWallet(u).balance, 80, 'the fill debits the reserved USD');
});

test('a sell limit fills at or above its target', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  createLimitOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 1.0, usdAmount: 100, tokenAmount: 100 });

  assert.equal(checkLimitOrders(u, new Map([[ADDR, 0.9]])).length, 0, 'below target: no fill');
  assert.equal(checkLimitOrders(u, new Map([[ADDR, 1.0]])).length, 1, 'at target: fills');
  assert.equal(getPositions(u).length, 0, 'the whole position was sold');
  assertMoney(getWallet(u).balance, 150, '$50 spent, $100 received');
});

test('an absurd, zero, or non-finite upstream price can never fill an order', () => {
  const u = freshUser();
  createLimitOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 1000, usdAmount: 20, tokenAmount: 50 });

  for (const bad of [0, -1, NaN, Infinity, 1e13]) {
    assert.equal(checkLimitOrders(u, new Map([[ADDR, bad]])).length, 0, `price ${bad} must not fill`);
  }
  assert.equal(getOrders(u)[0].status, 'open', 'the order is still open after every bad tick');
});

test('a limit whose fill can no longer execute is cancelled, not left filled', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  const limit = createLimitOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 1.0, usdAmount: 100, tokenAmount: 100 });

  // The holding disappears before the target is reached — a real state, since
  // a confirmed real-wallet sell reduces the mirror out from under it.
  reducePositionAmount(u, ADDR, 100);
  const filled = checkLimitOrders(u, new Map([[ADDR, 1.0]]));

  assert.equal(filled.length, 1);
  assert.ok(filled[0].error, 'the failed fill is reported, not swallowed');
  assert.equal(getOrders(u).find((o) => o.id === limit.id).status, 'cancelled', 'an unexecutable limit rolls back to cancelled');
});

test('a price map entry that is absent leaves the order open', () => {
  const u = freshUser();
  createLimitOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', targetPrice: 0.4, usdAmount: 20, tokenAmount: 50 });

  assert.equal(checkLimitOrders(u, new Map()).length, 0);
  assert.equal(checkLimitOrders(u, new Map([[OTHER, 0.1]])).length, 0, 'a price for a different token must not fill this one');
});

/* ---------------- derived numbers and corruption ---------------- */

test('total value tracks the live price, not the entry price', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  updatePositionPrices(u, new Map([[ADDR, 2.0]]));

  // 100 tokens at $2.00 = $200 of positions on top of the $50 cash left.
  const w = getWallet(u);
  assertMoney(w.totalPositionValue, 200, 'positions revalued');
  assertMoney(w.totalValue, 250, 'cash plus positions');
  assertMoney(w.unrealizedPnl, 150, 'unrealized gain on the open position');
});

test('a corrupt position row is dropped at load, not allowed to poison the totals', () => {
  const u = freshUser();
  // The 1.38e+47-token incident: an absurd amount must not become a number the
  // rest of the app trusts.
  writeFileSync(join(TEMP_DIR, `${u}.json`), JSON.stringify({
    balance: 100,
    initialBalance: 100,
    nextOrderId: 1,
    positions: [
      { tokenAddress: ADDR, amount: 1.38e47, avgBuyPrice: 0.5, totalCost: 10, currentPrice: 0.5 },
      { tokenAddress: OTHER, amount: 10, avgBuyPrice: 1, totalCost: 10, currentPrice: 1 },
    ],
    orders: [],
  }));

  initWallet(u);
  const positions = getPositions(u);
  assert.equal(positions.length, 1, 'only the valid row survives');
  assert.equal(positions[0].tokenAddress, OTHER);
  assertMoney(getWallet(u).totalPositionValue, 10, 'the corrupt row contributes nothing');
  assertMoney(getWallet(u).totalValue, 110, 'and does not inflate the account');
});

test('sell proceeds cannot inflate the balance past the ledger ceiling', () => {
  const u = freshUser();
  resetWallet(u, 1_000_000);
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 500_000, tokenAmount: 0, currentPrice: 1 });
  // 500k tokens at $3 = $1.5M on a $500k cash balance; the cap has to hold.
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 500_000, currentPrice: 3 });

  assertMoney(getWallet(u).balance, 1_000_000, 'balance is clamped to the ceiling');
});

test('realized PnL survives a restart, and a legacy file is migrated not zeroed', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });
  assertMoney(getWallet(u).realizedPnl, 20, 'booked before the restart');

  // Write the current state, then reload it the way a boot would.
  flushAll();
  initWallet(u);
  assertMoney(getWallet(u).realizedPnl, 20, 'the total must not reset to 0 on restart');

  // A state file from before wallet-level tracking: no realizedPnl field, the
  // figure only on the open positions. It must be recovered, not dropped.
  const legacyUser = freshUser();
  writeFileSync(join(TEMP_DIR, `${legacyUser}.json`), JSON.stringify({
    balance: 60,
    initialBalance: 100,
    nextOrderId: 1,
    positions: [{ tokenAddress: ADDR, symbol: 'TEST', amount: 10, avgBuyPrice: 1, totalCost: 10, currentPrice: 1, realizedPnl: 7.5 }],
    orders: [],
  }));
  initWallet(legacyUser);
  assertMoney(getWallet(legacyUser).realizedPnl, 7.5, 'legacy per-position PnL is carried over');
});

test('reset clears positions and orders and restores the starting balance', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });

  const w = resetWallet(u, 250);
  assertMoney(w.balance, 250, 'new starting balance');
  assert.equal(getPositions(u).length, 0, 'positions cleared');
  assert.equal(getOrders(u).length, 0, 'order history cleared');
});

/* ---------------- real-wallet mirroring ---------------- */

test('a mirrored buy REPLACES the position rather than blending real and paper fills', () => {
  const u = freshUser();
  addMirroredPosition(u, { tokenAddress: ADDR, symbol: 'TEST', chainId: 'base', tokens: 100, price: 0.5 });
  addMirroredPosition(u, { tokenAddress: ADDR, symbol: 'TEST', chainId: 'base', tokens: 40, price: 2 });

  // Averaging these would give 140 tokens at $1.07 — an entry that belongs to
  // neither fill, and a sell the wallet cannot cover.
  const [pos] = getPositions(u);
  assert.equal(pos.amount, 40);
  assertMoney(pos.avgBuyPrice, 2, 'the real fill sets the economics outright');
  assert.equal(pos.symbol, 'TEST', 'identity metadata is kept');
});

test('reducing a mirrored position scales the cost basis and removes it at zero', () => {
  const u = freshUser();
  addMirroredPosition(u, { tokenAddress: ADDR, symbol: 'TEST', chainId: 'base', tokens: 100, price: 0.5 });

  reducePositionAmount(u, ADDR, 40);
  const [pos] = getPositions(u);
  assert.equal(pos.amount, 60);
  assertMoney(pos.avgBuyPrice, 0.5, 'entry is unchanged');
  assertMoney(pos.totalCost, 30, 'cost basis follows the tokens left');

  reducePositionAmount(u, ADDR, 60);
  assert.equal(getPositions(u).length, 0, 'the position is removed once fully reduced');
});

test('a mirrored position with an impossible price or size is refused', () => {
  const u = freshUser();
  for (const bad of [{ tokens: 0, price: 1 }, { tokens: -5, price: 1 }, { tokens: 1, price: 0 }, { tokens: 1, price: NaN }, { tokens: 1e31, price: 1 }]) {
    assert.equal(addMirroredPosition(u, { tokenAddress: ADDR, chainId: 'base', ...bad }), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(getPositions(u).length, 0, 'nothing was recorded');
});

test('the risk ledger records realized PnL and survives a restart', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });

  const led = getRiskLedger(u);
  assert.equal(led.length, 1, 'one realized booking, one ledger row');
  assertMoney(led[0].usd, 20, 'the ledger row matches the booked P&L');
  assert.equal(Number.isFinite(led[0].ts), true, 'a row without a timestamp can never age out');

  flushAll();
  initWallet(u);
  const after = getRiskLedger(u);
  assert.equal(after.length, 1, 'the ledger must not be lost on restart — the cap would reset');
  assertMoney(after[0].usd, 20, 'and must not be rewritten');
});

test('a corrupt ledger row is dropped on load rather than counting forever', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });
  flushAll();

  // riskGuard counts an unreadable row as inside the 24h window (fail closed),
  // so one row with a NaN timestamp would suppress every buy for a full day.
  const p = join(TEMP_DIR, `${u}.json`);
  const state = JSON.parse(readFileSync(p, 'utf-8'));
  state.riskLedger.push({ ts: 'nope', usd: -999 }, { ts: Date.now(), usd: 5 }, null);
  writeFileSync(p, JSON.stringify(state));

  initWallet(u);
  const led = getRiskLedger(u);
  assert.equal(led.length, 2, 'the two well-formed rows survive; the bad ts and the null are dropped');
  assertMoney(led[0].usd, 20, 'and the real booking is untouched');
  assertMoney(led[1].usd, 5, 'a second valid row is not over-filtered');
  assert.equal(led.every((e) => Number.isFinite(e.ts)), true, 'nothing unreadable reaches the cap');
});

test('getRiskLedger hands out a copy — a reader cannot rewrite the wallet', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });

  const led = getRiskLedger(u);
  led[0].usd = -1e6;
  assertMoney(getRiskLedger(u)[0].usd, 20, 'mutating the returned array must not touch wallet state');
});

test('the ledger is cleared by a reset, so the loss cap starts clean', () => {
  const u = freshUser();
  executeMarketOrder(u, { side: 'buy', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', usdAmount: 50, tokenAmount: 0, currentPrice: 0.5 });
  executeMarketOrder(u, { side: 'sell', tokenAddress: ADDR, chainId: 'base', symbol: 'TEST', tokenAmount: 100, currentPrice: 0.7 });
  assert.equal(getRiskLedger(u).length, 1);

  resetWallet(u, 100);
  assert.equal(getRiskLedger(u).length, 0, 'a wiped account cannot be permanently loss-blocked');
});
