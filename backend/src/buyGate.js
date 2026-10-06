// The buy-path risk gate: one function that both the scout (autopilot intent
// emitter) and the manual-intent endpoint call before an intent is created.
//
// riskGuard.evaluate owns the policy; this module owns the WIRING that was
// missing. It reads the user's realized-PnL ledger and calls evaluate in
// PRE-QUOTE mode, because the emitter runs before any swap quote exists — the
// quote-dependent gates (minAmountOut, gas ceiling, slippage, quote age) fire
// later, inside the swap builder, which is the only place that can see a quote.
//
// Why emit-time and not sign-time: the backend never holds a key and never
// signs. A buy becomes a real intent the user approves in MetaMask, and the
// swap tx is built by /api/real/swap-tx. Gating only at the emitter would still
// be reachable by a hand-crafted intent, so the emitter is where the daily-loss
// cap and token-quality checks must live to stop a bad buy from ever being
// proposed.

import { evaluate } from './riskGuard.js';
import { getRiskLedger } from './wallet.js';
import { DATA_DIR } from './persistence.js';

/**
 * Run the pre-quote buy gates for a user.
 *
 * @param {object}  p
 * @param {string}  p.userId       whose ledger to consult; null skips the ledger
 * @param {string} [p.side]        'buy' (default) or 'sell' — sells are never capped
 * @param {number}  p.usdAmount    the buy's USD size
 * @param {object} [p.token]       { liquidityUsd, fdv, txns24h:{buys,sells} }
 * @param {number} [p.balanceUsd]  on-chain balance when known (real mode)
 * @param {number} [p.now]         injectable clock, for tests
 * @param {object} [p.limits]      overrides; defaults to riskGuard's LIMITS
 * @returns {{ok:boolean, code:string|null, message:string|null}}
 */
export function evaluateBuyGate({ userId, side = 'buy', usdAmount, token = null, balanceUsd = null, now = Date.now(), limits } = {}) {
  const ctx = {
    now,
    ledger: userId ? getRiskLedger(userId) : null,
    token,
    usdAmount,
    dataDir: DATA_DIR,
    // No quote exists at emit time; every check that does not need one still runs.
    requireQuote: false,
  };
  if (limits) ctx.limits = limits;
  if (balanceUsd !== null) ctx.balanceUsd = balanceUsd;
  return evaluate({ side }, ctx);
}
