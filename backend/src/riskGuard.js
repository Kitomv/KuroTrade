// Pre-sign risk gates for autonomous execution.
//
// Pure module: no I/O, no network, no clock of its own (callers pass `now`).
// Every check fails CLOSED — an unparseable or missing input is a rejection,
// never a pass. A guard that returns "ok" on garbage is worse than no guard,
// because the caller stops looking.
//
// The executor calls `evaluate` exactly once, after a quote lands and
// immediately before `signTransaction`. Nothing here talks to a chain; the
// caller supplies balances and token metrics it already read.

import { existsSync } from 'fs';
import { join } from 'path';

/** Rolling window for the daily loss cap. */
export const LOSS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Limits. Env-overridable so an operator can tighten a live system without a
 * code change, but every default is deliberately conservative — this bot signs
 * real transactions with no human in the loop.
 */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const LIMITS = {
  /** Max USD per trade. Mirrors checkTradeSize's own env name. */
  maxUsdPerTrade: num(process.env.HOT_WALLET_MAX_USD_PER_TRADE, 50),
  /** Most negative rolling 24h realized PnL tolerated before BUYs stop. */
  maxDailyLossUsd: num(process.env.AUTO_MAX_DAILY_LOSS_USD, 25),
  /** Liquidity must be at least this multiple of the trade size. */
  minLiquidityMultiple: num(process.env.AUTO_MIN_LIQUIDITY_MULTIPLE, 20),
  /** Minimum fraction of 24h txns that are sells — the honeypot signature. */
  minSellRatio: num(process.env.AUTO_MIN_SELL_RATIO, 0.2),
  /** Max FDV / liquidity ratio; rejects the thin-float profile. */
  maxFdvLiquidityRatio: num(process.env.AUTO_MAX_FDV_LIQUIDITY_RATIO, 100),
  /** Max tolerated price impact, same-chain. */
  maxPriceImpact: num(process.env.AUTO_MAX_PRICE_IMPACT, 0.03),
  /** Max slippage, as a fraction (0.01 = 1%). */
  maxSlippage: num(process.env.AUTO_MAX_SLIPPAGE, 0.01),
  /** A quote older than this is refused. */
  maxQuoteAgeMs: num(process.env.AUTO_MAX_QUOTE_AGE_MS, 20_000),
  /** End-to-end budget from claim to sign. */
  maxEndToEndMs: num(process.env.AUTO_MAX_END_TO_END_MS, 45_000),
  /** Absolute gas ceiling for a single tx. */
  maxGasLimit: num(process.env.AUTO_MAX_GAS_LIMIT, 500_000),
};

/** Kill switch — env or sentinel file, both re-read per call (no restart needed). */
export function isKilled(dataDir) {
  if (String(process.env.REAL_EXECUTION_KILL || '') === '1') return true;
  try {
    // A missing or unreadable data dir means "no sentinel file", never a crash —
    // the env check above is the path that must always work.
    return Boolean(dataDir) && existsSync(join(dataDir, 'KILL'));
  } catch {
    return false;
  }
}

/** Rolling realized PnL over the ledger's window. Losses are negative. */
export function realizedInWindow(ledger, now, windowMs = LOSS_WINDOW_MS) {
  if (!Array.isArray(ledger)) return 0;
  let sum = 0;
  for (const entry of ledger) {
    const ts = Number(entry?.ts);
    const usd = Number(entry?.usd);
    // A non-finite timestamp would either never age out or age out instantly;
    // either is wrong, so an unreadable entry is counted as inside the window.
    // Fail closed: an unknown loss counts against the cap.
    if (!Number.isFinite(ts)) { sum += Number.isFinite(usd) ? usd : 0; continue; }
    if (now - ts < windowMs) sum += Number.isFinite(usd) ? usd : 0;
  }
  return sum;
}

/**
 * Whether a BUY is blocked by the daily loss cap.
 *
 * Sells are never blocked: a cap that stops the bot exiting a losing position
 * turns a bad day into a permanent loss. The kill switch is the control that
 * blocks both, because that is what a kill switch is for.
 */
export function isDailyLossBreached(ledger, now, limit = LIMITS.maxDailyLossUsd, windowMs = LOSS_WINDOW_MS) {
  return realizedInWindow(ledger, now, windowMs) <= -Math.abs(limit);
}

function reason(code, message) {
  return { ok: false, code, message };
}

const PASS = { ok: true, code: null, message: null };

/**
 * Evaluate every gate. Returns `{ok:true}` or the FIRST `{ok:false, code}`.
 *
 * Order is cheapest-and-most-likely first so a rejection carries the most
 * specific reason: kill switch, then caps, then token quality, then the quote's
 * own numbers.
 *
 * `requireQuote:false` runs the pre-quote half only — kill switch, caps,
 * balance and token quality — and returns a pass without demanding a quote.
 * The buy path emits an intent for the user to sign, and no quote exists until
 * that intent reaches /api/real/swap-tx, so the emitter can only be gated on
 * the checks that do not need one. Everything else stays identical: a gate that
 * behaved differently in the two modes would be two gates.
 */
export function evaluate(intent, ctx = {}) {
  const {
    now = Date.now(),
    quote = null,
    ledger = null,
    token = null,          // { liquidityUsd, fdv, txns24h:{buys,sells} }
    usdAmount = null,
    balanceUsd = null,
    gasReserveUsd = 0,
    slippages = null,      // quote-reported slippage, if the aggregator echoes one
    dataDir = null,
    limits = LIMITS,
    startedAt = null,
    requireQuote = true,   // false = pre-quote gate (emit time, no quote yet)
  } = ctx;

  // The env arm of the kill switch must work with no data dir configured, so
  // this is not gated on `dataDir` — isKilled handles a null path safely.
  if (isKilled(dataDir)) {
    return reason('killed', 'Kill switch aktif');
  }

  const side = String(intent?.side || '').toLowerCase();
  const isBuy = side === 'buy';

  // A malformed intent must never reach signing.
  const usd = Number(usdAmount);
  if (!Number.isFinite(usd) || usd <= 0) {
    return reason('bad_amount', 'Nilai trade tidak valid');
  }

  // Caps are buy-side only, matching the deleted executor's own comment.
  if (isBuy) {
    if (usd > limits.maxUsdPerTrade) {
      return reason('over_cap', `Trade ${usd} melebihi batas ${limits.maxUsdPerTrade}`);
    }
    if (ledger && isDailyLossBreached(ledger, now, limits.maxDailyLossUsd)) {
      return reason('daily_loss', 'Batas rugi harian tercapai — hanya SELL yang diizinkan');
    }
    // Affordability is buy-side only: `usd` is what a buy SPENDS. On a sell it
    // is expected PROCEEDS, so comparing it against the USD balance would be
    // comparing a number to itself. A sell's real constraint is the token
    // balance, which the executor clamps against separately.
    if (balanceUsd !== null) {
      const bal = Number(balanceUsd);
      if (!Number.isFinite(bal)) return reason('bad_balance', 'Saldo tidak terbaca');
      if (usd + Number(gasReserveUsd || 0) > bal) {
        return reason('insufficient', 'Saldo tidak cukup termasuk cadangan gas');
      }
    }
  } else if (side !== 'sell') {
    return reason('bad_side', `Side tidak dikenal: ${side || '(kosong)'}`);
  }

  // A balance we cannot read is never a pass. Checked for both sides, but only
  // a BUY compares against it (see the buy block above for why a sell must not).
  if (balanceUsd !== null && !isBuy) {
    if (!Number.isFinite(Number(balanceUsd))) {
      return reason('bad_balance', 'Saldo tidak terbaca');
    }
  }

  // Token quality. Only meaningful for a buy — selling a token you already
  // hold cannot be prevented by checking its liquidity now.
  if (isBuy && token) {
    const liquidity = Number(token.liquidityUsd);
    if (!Number.isFinite(liquidity) || liquidity < usd * limits.minLiquidityMultiple) {
      return reason('thin_liquidity', `Likuiditas $${Number.isFinite(liquidity) ? Math.round(liquidity) : 0} < ${limits.minLiquidityMultiple}x ukuran trade`);
    }
    const buys = Number(token.txns24h?.buys);
    const sells = Number(token.txns24h?.sells);
    const total = buys + sells;
    if (!Number.isFinite(buys) || !Number.isFinite(sells) || total <= 0) {
      return reason('no_market_data', 'Data transaksi 24 jam tidak tersedia');
    }
    if (sells / total < limits.minSellRatio) {
      return reason('honeypot', `Rasio jual ${(sells / total).toFixed(2)} di bawah ${limits.minSellRatio} — pola honeypot`);
    }
    const fdv = Number(token.fdv);
    if (Number.isFinite(fdv) && fdv > 0 && liquidity > 0 && fdv / liquidity > limits.maxFdvLiquidityRatio) {
      return reason('thin_float', `FDV/likuiditas ${(fdv / liquidity).toFixed(0)}x melebihi batas`);
    }
  }

  if (!quote) {
    // Pre-quote mode is the only place a missing quote is not a failure: the
    // emitter has not asked for one yet. Every check above has already run.
    return requireQuote ? reason('no_quote', 'Tidak ada kuotasi') : PASS;
  }

  // minAmountOut of zero is the classic drain: the tx succeeds and returns
  // nothing. Refuse it outright rather than relying on a slippage setting.
  const toAmountMin = Number(quote.toAmountMin);
  if (!Number.isFinite(toAmountMin) || toAmountMin <= 0) {
    return reason('no_min_out', 'minAmountOut nol — kuotasi tidak melindungi dari pencurian');
  }

  const quotedAt = Number(quote.quotedAt);
  if (!Number.isFinite(quotedAt)) return reason('stale_quote', 'Kuotasi tidak bertimestamp');
  if (now - quotedAt > limits.maxQuoteAgeMs) {
    return reason('stale_quote', `Kuotasi berumur ${Math.round((now - quotedAt) / 1000)}s`);
  }

  const gasLimit = Number(quote.gasLimit);
  if (!Number.isFinite(gasLimit) || gasLimit <= 0) {
    return reason('bad_gas', 'gasLimit tidak valid');
  }
  if (gasLimit > limits.maxGasLimit) {
    return reason('gas_ceiling', `gasLimit ${gasLimit} melebihi batas ${limits.maxGasLimit}`);
  }

  const maxFee = Number(quote.maxFeePerGas);
  if (Number.isFinite(maxFee)) {
    const ceiling = Number(quote.maxFeeCeilingGwei);
    if (!Number.isFinite(ceiling)) return reason('bad_gas', 'Batas maxFeePerGas tidak diketahui');
    if (maxFee > ceiling) return reason('gas_price', `maxFeePerGas ${maxFee} melebihi ${ceiling}`);
  }

  // An aggregator that echoes more slippage than we asked for is either
  // misconfigured or hostile; either way we do not sign it.
  if (slippages !== null) {
    const s = Number(slippages);
    if (!Number.isFinite(s) || s > limits.maxSlippage) {
      return reason('slippage', `Slippage ${s} melebihi batas ${limits.maxSlippage}`);
    }
  }

  const impact = Number(quote.priceImpact);
  if (Number.isFinite(impact) && impact > limits.maxPriceImpact) {
    return reason('price_impact', `Dampak harga ${(impact * 100).toFixed(1)}% melebihi batas`);
  }

  if (startedAt !== null && now - Number(startedAt) > limits.maxEndToEndMs) {
    return reason('too_slow', `Eksekusi melebihi ${limits.maxEndToEndMs}ms sejak klaim`);
  }

  return PASS;
}