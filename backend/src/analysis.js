// Deterministic scoring — the numeric core of the multi-agent engine.
//
// Extracted from aiAgent.js so the math can be read, tested and changed on its
// own. Every function here is pure: no state, no userId, no network. The LLM
// path blends on top of these numbers; when no provider key is configured they
// are the whole decision.
//
// Imported by aiAgent.js (analyzeToken, the scanner's pre-filter) and covered
// directly by aiAgent.test.mjs.
// `ponytail:` the thresholds below are the tunable surface of the engine; if
// they get frequent per-token overrides, promote them to named config in
// DEFAULT_AUTOPILOT rather than growing argument lists.
import { isSupportedChain } from './evmWallet.js';

export function runTechnicalAnalysis(market) {
  const priceUsd = Number(market.priceUsd) || 0;
  const change5m = Number(market.change5m) || 0;
  const change1h = Number(market.change1h) || 0;
  const change24h = Number(market.change24h) || 0;
  const volume24h = Number(market.volume24h) || 0;
  const liquidityUsd = Number(market.liquidityUsd) || 0;
  const fdv = Number(market.fdv) || 0;

  const txns = market.txns24h ?? {};
  const buys = Number(txns.buys) || 0;
  const sells = Number(txns.sells) || 0;
  const totalTxns = buys + sells;
  const buyRatio = totalTxns > 0 ? (buys / totalTxns) * 100 : 50;

  const momentumScore = (change5m * 0.4) + (change1h * 0.4) + (change24h * 0.2);
  const volToLiqRatio = liquidityUsd > 0 ? volume24h / liquidityUsd : 0;

  const isBreakout = change5m >= 2.0 && buyRatio >= 58;
  const isVolumeSurge = volToLiqRatio >= 1.0 && volume24h > 20000;

  let trend = 'NEUTRAL';
  if (isBreakout && change1h > 2) trend = 'MOMENTUM_BREAKOUT';
  else if (change5m > 1 && change1h > 3) trend = 'STRONG_BULLISH';
  else if (change1h > 0 && change24h > 0) trend = 'BULLISH';
  else if (change5m < -1 && change1h < -3) trend = 'STRONG_BEARISH';
  else if (change1h < 0 && change24h < 0) trend = 'BEARISH';

  const findings = [
    `Trend ${trend.replace('_', ' ')}: 5m (${change5m > 0 ? '+' : ''}${change5m.toFixed(2)}%), 1h (${change1h > 0 ? '+' : ''}${change1h.toFixed(2)}%), 24h (${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%)`,
    `Order Flow: ${buyRatio.toFixed(0)}% Buy pressure (${buys} buys vs ${sells} sells dalam 24h)`,
    `Vol/Liq turnover: ${volToLiqRatio.toFixed(2)}x ($${(volume24h / 1000).toFixed(1)}k vol vs $${(liquidityUsd / 1000).toFixed(1)}k liq)`,
  ];

  if (isBreakout) findings.unshift(`⚡ [BREAKOUT SURGE] Lonjakan candle 5m (+${change5m.toFixed(2)}%) didukung tekanan beli ${buyRatio}%!`);

  return {
    trend,
    momentumScore: Math.round(momentumScore * 100) / 100,
    buyRatio: Math.round(buyRatio),
    buys,
    sells,
    volToLiqRatio: Math.round(volToLiqRatio * 100) / 100,
    liquidityUsd,
    volume24h,
    priceUsd,
    fdv,
    isBreakout,
    isVolumeSurge,
    findings,
  };
}

export function runBullThesis(market, tech) {
  const points = [];
  let bullScore = 50;

  if (tech.isBreakout) { points.push(`Katalis Breakout Volume terdeteksi pada 5m dengan rasio beli ${tech.buyRatio}%`); bullScore += 20; }
  if (tech.buyRatio > 55) { points.push(`Dominasi buyer kuat di angka ${tech.buyRatio}%`); bullScore += 15; }
  if ((Number(market.change5m) || 0) > 0 && (Number(market.change1h) || 0) > 0) { points.push('Momentum timeframe pendek selaras positif (5m & 1h hijau)'); bullScore += 15; }
  if (tech.volToLiqRatio > 0.5 && tech.volToLiqRatio < 5) { points.push(`Aktivitas trading sehat dengan rasio turnover ${tech.volToLiqRatio}x`); bullScore += 10; }
  if (tech.liquidityUsd > 50000) { points.push(`Likuiditas pool tebal ($${(tech.liquidityUsd / 1000).toFixed(1)}k), slippage rendah`); bullScore += 10; }

  if (points.length === 0) { points.push('Kondisi pasar saat ini belum menunjukkan katalis bullish yang jelas.'); bullScore = 30; }

  return {
    score: Math.min(95, bullScore),
    thesis: points,
    quote: `Katalis volume & buy flow mendukung potensi ekspansi harga ke atas.`,
  };
}

export function runBearThesis(market, tech) {
  const warnings = [];
  let bearScore = 30;

  if (tech.liquidityUsd < 10000) { warnings.push(`⚠️ Likuiditas sangat tipis ($${(tech.liquidityUsd / 1000).toFixed(1)}k) — Risiko slippage ekstrem & dump besar`); bearScore += 35; }
  if (tech.buyRatio < 45) { warnings.push(`Tekanan jual tinggi: ${100 - tech.buyRatio}% transaksi adalah SELL`); bearScore += 20; }
  if ((Number(market.change24h) || 0) > 100) { warnings.push(`Harga sudah naik ${Number(market.change24h).toFixed(0)}% dalam 24h — Waspada take-profit massal / koreksi tajam`); bearScore += 20; }
  if ((Number(market.change5m) || 0) < -3) { warnings.push('Terdeteksi dump cepat pada candle 5 menit terakhir'); bearScore += 15; }
  if (tech.fdv > 0 && tech.liquidityUsd > 0 && (tech.fdv / tech.liquidityUsd) > 100) { warnings.push(`Rasio FDV/Liq sangat tinggi (${(tech.fdv / tech.liquidityUsd).toFixed(0)}x) — Potensi unlock atau supply dump`); bearScore += 15; }

  if (warnings.length === 0) { warnings.push('Tidak ditemukan red flag on-chain yang signifikan pada metrik saat ini.'); bearScore = 20; }

  return {
    score: Math.min(95, bearScore),
    risks: warnings,
    quote: `Waspadai titik likuiditas dan potensi reversal jika buyer kehabisan tenaga.`,
  };
}

export function runRiskAssessment(market, tech, bull, bear, walletBalance, riskLevel = 'medium') {
  let approved = true;
  let rejectionReason = null;
  // Per-user Guardian risk level drives per-trade sizing. This is the knob the
  // user sets in the Agents UI (Low/Medium/High); it must actually size trades
  // or the setting is cosmetic. Hot-wallet trades are additionally clamped by
  // HOT_WALLET_MAX_USD_PER_TRADE (a hard safety ceiling in checkTradeSize), so
  // the two settings compose: riskLevel sets the target, env sets the ceiling.
  const ALLOCATION_BY_RISK = { low: 0.10, medium: 0.20, high: 0.35 };
  let maxAllocationPct = ALLOCATION_BY_RISK[riskLevel] ?? ALLOCATION_BY_RISK.medium;

  if (tech.liquidityUsd < 5000) { approved = false; rejectionReason = 'Likuiditas pool di bawah batas aman minimum $5,000 USD.'; }
  else if (bear.score > 75) { approved = false; rejectionReason = 'Skor risiko Bearish melampaui batas toleransi (>75%).'; }

  // Extra caution for thinner pools: cap the allocation even on High risk.
  if (tech.liquidityUsd < 20000) maxAllocationPct = Math.min(maxAllocationPct, 0.10);

  const currentPrice = tech.priceUsd > 0 ? tech.priceUsd : 0.000001;
  const safeBalance = Number.isFinite(Number(walletBalance)) && Number(walletBalance) > 0 ? Number(walletBalance) : 100;
  const maxUsdPosition = Math.max(1, Math.round((safeBalance * maxAllocationPct) * 100) / 100);

  const stopLossPct = 7;
  const targetProfitPct = 15;
  const stopLossPrice = currentPrice * (1 - stopLossPct / 100);
  const takeProfitPrice = currentPrice * (1 + targetProfitPct / 100);

  return {
    approved,
    rejectionReason,
    maxAllocationPct: Math.round(maxAllocationPct * 100),
    maxUsdPosition,
    stopLossPct,
    targetProfitPct,
    stopLossPrice,
    takeProfitPrice,
  };
}

/**
 * Deterministic pre-filter for the scan — rejects tokens that would waste LLM
 * calls. Uses the same hard gates as runRiskAssessment but without per-user
 * sizing (those are independent of the token's intrinsic quality).
 *
 * EVM only: the execution layer is 1inch + MetaMask, so a non-EVM chain can
 * never be filled and admitting it would strand an intent and block dedup.
 */
export function passesPreFilter(market) {
  if (!market || !market.priceUsd) return false;
  // An intent for a chain the execution layer cannot fill stays 'open' forever
  // and blocks buy-dedup. DexScreener indexes many chains; accept only those
  // the wallet can actually trade.
  if (!isSupportedChain(market.chainId)) return false;
  const liq = Number(market.liquidityUsd) || 0;
  if (liq < 10000) return false;              // hard gate in runRiskAssessment
  const vol = Number(market.volume24h) || 0;
  if (liq > 0 && vol / liq < 0.05) return false; // nearly dead market
  return true;
}
