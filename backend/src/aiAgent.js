// Native Multi-Agent Trading Engine (TauricResearch inspired)
// Per-user autonomous pilot: state keyed by userId, merged into user's persisted file.

import { dexscreener } from './dexscreener.js';
import { executeMarketOrder, getWallet, getPositions, updatePositionMetadata, saveUserState } from './wallet.js';
import { getWatchlist } from './store.js';
import { callLLM, getLLMConfig } from './llmClient.js';
import { loadUserState, registerStateProvider } from './persistence.js';
import {
  addRealIntent,
  getRealIntents,
  setRealIntentStatus,
  setRealMode,
  isRealMode,
  registerAutopilotModule,
} from './realIntent.js';
import { getChainConfig, isSupportedChain } from './evmWallet.js';

const DEFAULT_AUTOPILOT = () => ({
  enabled: false,
  status: 'IDLE', // 'IDLE' | 'SCANNING' | 'GUARDIAN' | 'PAUSED'
  riskLevel: 'medium',
  minConfidence: 75,
  takeProfitPct: 15,
  stopLossPct: 7,
  trailingStopPct: 4,
  trailingTriggerPct: 6,
  moonbagX: 2,
  maxOpenPositions: 3,
  rotateAfterHours: 24, // stagnant rotation threshold
  maxExposurePct: 80,   // max % of totalValue in positions+reserved
  agentMode: 'blend',   // 'blend' | 'deterministic' | 'llm'
  debateRounds: 1,      // reserved: future multi-round debate
  llmTemperature: 0.3,  // LLM sampling temperature (lower = more reproducible)
  llmTimeoutMs: 30_000, // per-provider request timeout (was a hardcoded 90s)
  scanConcurrency: 3,   // parallel analyzeToken calls per scan (1-6)
  enableLeadSynthesis: true, // 3rd LLM call that writes the verdict prose
  lastScanAt: null,
  nextScanInSeconds: 15,
  stats: { totalScans: 0, totalTrades: 0, profitableTrades: 0, totalProfitUsd: 0, winRate: 0 },
  logs: [],
  guardedPositions: [],
  pnlHistory: [],
  signalHistory: [],  // [{ ts, symbol, address, signal, confidence, entryPrice, bull, bear, llmPowered, price1h?, price24h? }]
  slCooldowns: {},    // tokenAddress -> untilTs (skip scout after a stop-loss)
  memory: [],         // decision memory: [{ ts, symbol, signal, confidence, entryPrice, outcomePct, regime, chainId, exitReason, holdMs, ... }]
  nearMisses: [],     // strong signals skipped by constraints: [{ ts, symbol, address, chainId, signal, confidence, entryPrice, reason }]
});

const autopilotStates = new Map(); // userId -> state
// Audit reports embed the caller's balance sizing + their LLM output, so the
// cache key must include the user — a shared key leaks one user's numbers.
const auditCache = new Map(); // `${userId}:${tokenAddress}` -> { ts, report, refreshing }
const AUDIT_TTL = 30_000;
// Reports older than AUDIT_TTL but younger than AUDIT_STALE_TTL are served
// immediately AND refreshed in the background. The guardian tick NEVER awaits
// the LLM; it gets a stale-but-usable report, while a background task refreshes.
const AUDIT_STALE_TTL = 10 * 60_000;

/**
 * Run `fn` over `items` with at most `limit` in flight. Preserves input order
 * in the result. Rejections are captured per-item (never abort the batch).
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = undefined; }
    }
  });
  await Promise.all(workers);
  return out;
}

// In-memory retry throttle for intents a user abandoned mid-approval:
// intentId -> nextAllowedRetryTimestamp. The frontend already backs off
// client-side; this bounds the guardian from re-emitting a warning about the
// same stuck intent on every 5s tick.
const intentReminderThrottles = new Map();
const INTENT_REMINDER_INTERVAL_MS = 5 * 60_000;

// Sweep entries whose window has already elapsed. They carry no information —
// shouldRemind() re-adds one the moment it reminds again — and without this an
// entry for every intent that ever waited for approval is retained forever.
// What remains is only intents reminded within the last window, so the map
// tracks pending approvals rather than total history.
setInterval(() => {
  const now = Date.now();
  for (const [intentId, nextAllowed] of intentReminderThrottles) {
    if (now >= nextAllowed) intentReminderThrottles.delete(intentId);
  }
}, INTENT_REMINDER_INTERVAL_MS).unref?.();

function shouldRemind(intentId) {
  const next = intentReminderThrottles.get(intentId) ?? 0;
  if (Date.now() < next) return false;
  intentReminderThrottles.set(intentId, Date.now() + INTENT_REMINDER_INTERVAL_MS);
  return true;
}

/**
 * Remind the user an intent is waiting for their MetaMask signature.
 *
 * The server no longer signs anything — every real trade now needs a human to
 * approve it in MetaMask (user instruction: "allin metamask pokoknya"). This
 * throttles the reminder so a permanently-stuck intent (browser closed, user
 * rejected) does not fill the log with the same line every 5s tick. The intent
 * itself stays 'open' until the user acts or the 30-minute TTL expires.
 */
function remindPendingApproval(userId, intent) {
  if (!shouldRemind(intent.id)) return null;
  addLog(userId, 'WARN', `⏳ [${intent.side.toUpperCase()}] ${intent.symbol} masih menunggu approve di MetaMask — buka tab lalu Approve (intent ${intent.id})`, {
    intentId: intent.id,
  });
  return intent;
}

function stateFor(userId) {
  if (!autopilotStates.has(userId)) autopilotStates.set(userId, DEFAULT_AUTOPILOT());
  return autopilotStates.get(userId);
}

/**
 * Record a REALIZED round trip into the cumulative stats.
 *
 * Every exit path funnels through here: guardian SL/TP/trailing, the TP1 partial,
 * and a MANUAL sell from the Portfolio page. They used to each inline the same
 * three lines, but only the guardian paths were instrumented — a manual hot
 * wallet sell executed real funds and still showed 0 trades / 0 profit / 0% win
 * rate, because the sell-position route resolves the intent server-side without
 * re-entering the agent loop.
 *
 * Idempotent per round trip: callers pass a `key` (the intent id) so a retried
 * exit cannot double-count the same PnL.
 */
export function recordRealized(userId, { pnlUsd, intentId = null, key = null } = {}) {
  const st = autopilotStates.get(userId);
  if (!st) return;
  if (!st.stats) st.stats = { ...DEFAULT_AUTOPILOT().stats };
  // Validate BEFORE claiming the dedup slot. Burning the key on a NaN PnL would
  // make a later, correct record for the same exit a silent no-op — the round
  // trip would be dropped from the totals instead of just being unrecorded once.
  const pnl = Number(pnlUsd);
  if (!Number.isFinite(pnl)) return;
  // Dedup: the same intent must never be counted twice, even if the exit is
  // retried (throttle retry sweep, manual retry after a failed send).
  if (key) {
    if (!Array.isArray(st.recordedExits)) st.recordedExits = [];
    if (st.recordedExits.includes(key)) return;
    st.recordedExits.unshift(key);
    if (st.recordedExits.length > 200) st.recordedExits.length = 200;
  }
  st.stats.totalTrades++;
  if (pnl > 0) st.stats.profitableTrades++;
  st.stats.totalProfitUsd += pnl;
  st.stats.winRate = st.stats.totalTrades > 0
    ? Math.round((st.stats.profitableTrades / st.stats.totalTrades) * 100)
    : 0;
  if (intentId) st.lastRealizedIntentId = intentId;
  saveUserState(userId);
}

/**
 * Log a confirmed real exit. Called from realIntent.js when an intent the user
 * approved in MetaMask reaches 'done' — the guardian tick cannot know that, so
 * the confirmation path reports it back here.
 */
export function logRealizedExit(userId, intent, pnlUsd) {
  addLog(userId, 'SELL', `✅ [${intent.source ?? 'EXIT'} REAL] ${intent.symbol} closed di MetaMask — PnL ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`, {
    intentId: intent.id,
    pnlUsd,
    symbol: intent.symbol,
  });
}

// realIntent.js books realized PnL when an intent is confirmed and calls back
// into recordRealized/logRealizedExit above. It imports nothing from this module
// (that would be a cycle), so it is wired here instead.
registerAutopilotModule({ recordRealized, logRealizedExit });

/** Load a user's persisted autopilot config on startup. */
export function initAutopilot(userId) {
  const saved = loadUserState(userId);
  if (saved?.autopilot) {
    const base = DEFAULT_AUTOPILOT();
    // Merge persisted slice on top of defaults. Stats only merge when present
    // (older saves lack them) so totals don't reset to 0 unexpectedly — but
    // once persisted they survive restarts, keeping "Auto-Trades Dieksekusi" /
    // "Profit Auto-Pilot Realized" in sync with on-chain hot-wallet activity.
    Object.assign(base, saved.autopilot);
    if (!saved.autopilot.stats) base.stats = DEFAULT_AUTOPILOT().stats;
    if (!Array.isArray(saved.autopilot.pnlHistory)) base.pnlHistory = [];
    autopilotStates.set(userId, base);
  }
}

// Autopilot slice provider — persists config AND cumulative stats + pnlHistory
// so "Auto-Trades Dieksekusi" and "Profit Auto-Pilot Realized" survive restarts
// and stay in sync with hot-wallet on-chain activity (was config-only; stats
// reset to 0 every boot, making realized PnL look like it desynced).
registerStateProvider((userId) => {
  const st = autopilotStates.get(userId);
  if (!st) return null;
  const {
    enabled, riskLevel, minConfidence, takeProfitPct, stopLossPct, trailingStopPct,
    trailingTriggerPct, moonbagX, maxOpenPositions, rotateAfterHours, maxExposurePct, agentMode,
    llmTemperature, llmTimeoutMs, scanConcurrency, enableLeadSynthesis,
    signalHistory, slCooldowns, memory, nearMisses, stats, pnlHistory, recordedExits,
  } = st;
  return {
    autopilot: {
      enabled, riskLevel, minConfidence, takeProfitPct, stopLossPct, trailingStopPct,
      trailingTriggerPct, moonbagX, maxOpenPositions, rotateAfterHours, maxExposurePct, agentMode,
      llmTemperature, llmTimeoutMs, scanConcurrency, enableLeadSynthesis,
      signalHistory: (signalHistory ?? []).slice(0, 200),
      slCooldowns,
      memory: (memory ?? []).slice(0, 50),
      nearMisses: (nearMisses ?? []).slice(0, 30),
      stats: st.stats ?? { totalScans: 0, totalTrades: 0, profitableTrades: 0, totalProfitUsd: 0, winRate: 0 },
      pnlHistory: (st.pnlHistory ?? []).slice(-120),
      // Dedup keys for realized-PnL accounting. Persisted so a restart cannot
      // re-count an exit that was already recorded (the retry sweep and a manual
      // retry both re-resolve the same intent).
      recordedExits: (recordedExits ?? []).slice(0, 200),
    },
  };
});

function addLog(userId, tag, msg, details = null) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    tag,
    msg,
    details,
  };
  const st = stateFor(userId);
  st.logs.unshift(entry);
  if (st.logs.length > 80) st.logs.pop();
}

/* ---------------- Deterministic agent logic (unchanged math) ---------------- */

function runTechnicalAnalysis(market) {
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

function runBullThesis(market, tech) {
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

function runBearThesis(market, tech) {
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

function runRiskAssessment(market, tech, bull, bear, walletBalance, riskLevel = 'medium') {
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

// Deterministic pre-filter for the scan — rejects tokens that would waste
// LLM calls. Uses the same hard gates as `runRiskAssessment` but without
// per-user sizing (those are independent of the token's intrinsic quality).
// EVM only: the execution layer is 1inch + MetaMask.
function passesPreFilter(market) {
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

/** Tolerant JSON parse for LLM replies (some routers wrap output in fences). */
const LLM_JSON_PARSE = (raw) => {
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { return {}; }
};

export async function analyzeToken(userId, queryOrAddress, preFetchedMarket = null) {
  if (!queryOrAddress) throw new Error('queryOrAddress is required');

  let market = preFetchedMarket;
  if (!market) {
    market = await dexscreener.token(queryOrAddress).catch(() => null);
    if (!market) {
      const searchResults = await dexscreener.search(queryOrAddress).catch(() => []);
      if (searchResults.length > 0) market = searchResults[0];
    }
  }
  if (!market || !market.tokenAddress) throw new Error(`Token "${queryOrAddress}" tidak ditemukan di DexScreener`);

  const wallet = getWallet(userId);
  const st = stateFor(userId);
  const tech = runTechnicalAnalysis(market);
  const llmCfg = getLLMConfig(userId);
  // Deterministic baseline — kept for blending + fallback.
  const detBull = runBullThesis(market, tech);
  const detBear = runBearThesis(market, tech);
  let bull = detBull;
  let bear = detBear;
  const agentMode = st.agentMode ?? 'blend';
  let llmUsed = false;

  if (llmCfg.hasKey && agentMode !== 'deterministic') {
    const marketData = `
Symbol: ${market.symbol} (${market.chainId})
Price: $${Number(market.priceUsd).toFixed(6)}
5m Change: ${tech.priceUsd ? `${Number(market.change5m).toFixed(2)}%` : '—'}
1h Change: ${Number(market.change1h).toFixed(2)}%
24h Change: ${Number(market.change24h).toFixed(2)}%
Buy Ratio (24h): ${tech.buyRatio}% (${tech.buys} buys vs ${tech.sells} sells)
Volume 24h: $${(tech.volume24h / 1000).toFixed(1)}k
Liquidity: $${(tech.liquidityUsd / 1000).toFixed(1)}k
FDV: $${(Number(market.fdv) / 1000000).toFixed(2)}M
Trend: ${tech.trend}
Vol/Liq Ratio: ${tech.volToLiqRatio}x`.trim();

    // Decision memory — relevant-pattern selection (same chain+regime first,
    // then recent fill) + aggregate pattern line. Calibration from signal
    // accuracy is appended so agents self-correct against recent outcomes.
    const memoryBlock = buildMemoryBlock(st, market, tech) + buildAccuracyBlock(st);

    const [bullRes, bearRes] = await Promise.allSettled([
      callLLM({
        systemPrompt: `You are a BULL RESEARCHER at a quantitative crypto hedge fund (TauricResearch). Construct the most compelling BULLISH argument for this DeFi token from the on-chain data. Focus: buy pressure, volume acceleration, liquidity depth, momentum, upside catalysts. Respond with JSON only: {"score": 0-95, "thesis": ["point1", ...], "quote": "one-sentence summary"}`,
        userPrompt: `Analyze this on-chain market data and build the BULL thesis:\n\n${marketData}${memoryBlock}`,
        temperature: st.llmTemperature ?? 0.3,
        role: 'bull',
        userId,
        timeoutMs: st.llmTimeoutMs,
      }),
      callLLM({
        systemPrompt: `You are a BEAR RESEARCHER at a quantitative crypto hedge fund (TauricResearch). Identify the most critical BEARISH risks and red flags for this DeFi token from on-chain data. Focus: rugpull risk, thin liquidity, selling pressure, FDV/liquidity, dump patterns, downside. Respond with JSON only: {"score": 0-95, "risks": ["risk1", ...], "quote": "one-sentence warning"}`,
        userPrompt: `Analyze this on-chain market data and identify the BEAR risks:\n\n${marketData}${memoryBlock}`,
        temperature: st.llmTemperature ?? 0.3,
        role: 'bear',
        userId,
        timeoutMs: st.llmTimeoutMs,
      }),
    ]);

    // Blend helper: mode 'llm' → replace; 'blend' → 60/40 weighted, or plain
    // average when the two disagree wildly (>40 pts) to cap LLM influence.
    const combine = (llmScore, detScore) => {
      const gap = Math.abs(llmScore - detScore);
      const blended = agentMode === 'llm'
        ? llmScore
        : gap > 40
          ? Math.round((llmScore + detScore) / 2)
          : Math.round(0.6 * llmScore + 0.4 * detScore);
      return { score: Math.min(95, Math.max(10, blended)), divergent: gap > 40, llmScore, detScore };
    };

    if (bullRes.status === 'fulfilled' && bullRes.value) {
      const p = LLM_JSON_PARSE(bullRes.value);
      const llmScore = Math.min(95, Math.max(10, Number(p.score) || detBull.score));
      const c = combine(llmScore, detBull.score);
      bull = {
        score: c.score,
        llmScore: c.llmScore,
        detScore: c.detScore,
        divergent: c.divergent,
        thesis: Array.isArray(p.thesis) ? p.thesis.slice(0, 5) : [p.thesis || 'No thesis provided'],
        quote: p.quote || 'Bull analysis completed.',
        llmPowered: true,
      };
      llmUsed = true;
    }
    if (bearRes.status === 'fulfilled' && bearRes.value) {
      const p = LLM_JSON_PARSE(bearRes.value);
      const llmScore = Math.min(95, Math.max(10, Number(p.score) || detBear.score));
      const c = combine(llmScore, detBear.score);
      bear = {
        score: c.score,
        llmScore: c.llmScore,
        detScore: c.detScore,
        divergent: c.divergent,
        risks: Array.isArray(p.risks) ? p.risks.slice(0, 5) : [p.risks || 'No risks identified'],
        quote: p.quote || 'Bear analysis completed.',
        llmPowered: true,
      };
      llmUsed = true;
    }
  }

  const risk = runRiskAssessment(market, tech, bull, bear, wallet.balance, st.riskLevel ?? 'medium');
  risk.stopLossPct = st.stopLossPct ?? 7;
  risk.targetProfitPct = st.takeProfitPct ?? 15;
  risk.stopLossPrice = (tech.priceUsd || 1) * (1 - risk.stopLossPct / 100);
  risk.takeProfitPrice = (tech.priceUsd || 1) * (1 + risk.targetProfitPct / 100);

  let signal = 'HOLD';
  let confidence = 50;
  if (risk.approved && bull.score > bear.score + 15) {
    if (bull.score >= 75) { signal = 'STRONG_BUY'; confidence = Math.round((bull.score * 0.7) + (100 - bear.score) * 0.3); }
    else { signal = 'BUY'; confidence = Math.round((bull.score * 0.6) + (100 - bear.score) * 0.4); }
  } else if (bear.score > bull.score + 15) {
    signal = 'SELL';
    confidence = Math.round((bear.score * 0.7) + (100 - bull.score) * 0.3);
  } else {
    signal = 'HOLD';
    confidence = Math.round(50 + Math.abs(bull.score - bear.score));
  }

  const heldAmount = signal === 'SELL'
    ? (getPositions(userId).find((p) => p.tokenAddress.toLowerCase() === market.tokenAddress.toLowerCase())?.amount ?? 0)
    : 0;
  const estimatedTokens = signal === 'SELL'
    ? heldAmount
    : (market.priceUsd > 0 ? risk.maxUsdPosition / market.priceUsd : 0);

  let summaryText;
  // Skip the 3rd LLM call entirely when disabled OR when the signal is HOLD
  // (the deterministic summary already covers it). Only STRONG_BUY/BUY/SELL
  // benefit from the prose rewrite.
  const doLead = llmCfg.hasKey && st.enableLeadSynthesis !== false && signal !== 'HOLD';
  if (doLead) {
    try {
      const synthRaw = await callLLM({
        systemPrompt: `You are the LEAD TRADER at a quantitative crypto hedge fund. Synthesize the bull/bear debate into a final trading decision. Respond with JSON only: {"verdict": "one-sentence recommendation including entry strategy, target, and risk management"}`,
        userPrompt: `
Token: ${market.symbol} @ $${Number(market.priceUsd).toFixed(6)}
Signal: ${signal} (Confidence: ${confidence}%)
Bull Score: ${bull.score}% — ${(bull.thesis || []).join(' | ')}
Bear Score: ${bear.score}% — ${(bear.risks || []).join(' | ')}
Risk: Max $${risk.maxUsdPosition} USDC, TP: $${risk.takeProfitPrice.toFixed(6)} (+${risk.targetProfitPct}%), SL: $${risk.stopLossPrice.toFixed(6)} (-${risk.stopLossPct}%)`,
        temperature: 0.3,
        role: 'lead',
        userId,
        timeoutMs: st.llmTimeoutMs,
      });
      if (synthRaw) summaryText = LLM_JSON_PARSE(synthRaw).verdict || null;
    } catch {}
  }
  if (!summaryText) {
    summaryText = signal.includes('BUY')
      ? `Rekomendasi ${signal}: Bull score ${bull.score}% vs Bear ${bear.score}%. Posisi $${risk.maxUsdPosition} USDC (${risk.maxAllocationPct}% saldo).`
      : signal === 'SELL'
      ? `Rekomendasi SELL: Risiko Bearish tinggi (${bear.score}%) akibat tekanan jual & on-chain warning.`
      : `Rekomendasi HOLD: Sinyal pasar berimbang (Bull ${bull.score}%, Bear ${bear.score}%). Tunggu konfirmasi.`;
  }

  return {
    timestamp: Date.now(),
    llmPowered: llmCfg.hasKey,
    llmProvider: llmCfg.hasKey ? `${llmCfg.provider} / ${llmCfg.model}` : 'Quantitative Engine',
    token: { address: market.tokenAddress, symbol: market.symbol ?? 'UNKNOWN', name: market.name ?? '', chainId: market.chainId ?? 'base', dexId: market.dexId ?? '', priceUsd: Number(market.priceUsd) || 0, icon: market.icon ?? undefined },
    agents: { technical: tech, bull, bear, risk },
    verdict: {
      signal,
      confidence,
      entryPrice: Number(market.priceUsd) || 0,
      targetPrice: risk.takeProfitPrice,
      stopLossPrice: risk.stopLossPrice,
      recommendedUsd: risk.maxUsdPosition,
      recommendedTokens: estimatedTokens,
      summary: summaryText,
    },
  };
}

/* ---------------- scan + autopilot (per user) ---------------- */

// Scan results embed per-user sizing (recommendedUsd from the caller's balance),
// so the cache and in-flight dedup must be keyed by userId — a shared cache
// would leak one user's position sizing to another.
const scanCacheByUser = new Map(); // userId -> { at, reports, limit }
const scanInFlightByUser = new Map(); // userId -> promise
const SCAN_CACHE_TTL = 5_000;

export async function scanMarketSignals(userId, limit = 10, opts = {}) {
  const st0 = stateFor(userId);
  const cached = scanCacheByUser.get(userId);
  // The cache is shared by callers with different depths (Overview asks for 3,
  // the Agents radar for 6), so a scan that collected fewer candidates than the
  // caller wants must not be served as if it were complete.
  const cacheUsable = cached && cached.limit >= limit;
  // Token-spend gate: the radar's LLM scans belong to autopilot. With autopilot
  // OFF, an open Overview/Agents tab polling every 5s must NOT keep buying
  // Bull/Bear/Lead calls — serve the last scan (or nothing) and never start a
  // new one. The explicit Analyze button (analyzeToken) is unaffected.
  if (!(opts.autopilotEnabled ?? st0.enabled === true)) {
    return cacheUsable ? cached.reports.slice(0, limit) : [];
  }
  if (cacheUsable && Date.now() - cached.at < SCAN_CACHE_TTL) return cached.reports.slice(0, limit);
  const inFlight = scanInFlightByUser.get(userId);
  if (inFlight) {
    if (opts.allowStale && cacheUsable) return cached.reports.slice(0, limit);
    return (await inFlight).slice(0, limit);
  }
  const promise = (async () => {
    const concurrency = Math.min(6, Math.max(1, st0.scanConcurrency ?? 3));
    const reports = [];
    const checked = new Set();
    const addrs = [];
    const add = (r) => { if (r) reports.push(r); };
    const push = (addr) => {
      if (!addr || checked.has(addr)) return;
      checked.add(addr);
      addrs.push(addr);
    };

    // 1. Candidate collection — cheap metadata calls only, no LLM yet.
    for (const w of getWatchlist(userId)) push(w.tokenAddress);

    if (addrs.length < limit) {
      try {
        const trendingProfiles = await dexscreener.tokenProfiles(15).catch(() => []);
        for (const tp of trendingProfiles) {
          if (tp.market && (Number(tp.market.liquidityUsd) || 0) < 10000) continue;
          push(tp.tokenAddress);
        }
      } catch {}
    }

    if (addrs.length < limit) {
      // Seed with multi-chain queries so the radar surfaces non-Solana pools.
      // One list per chain family; the pre-filter (SUPPORTED_CHAINS) still
      // gates which of these can actually reach a Bull/Bear call.
      const popularQueries = ['SOL', 'PEPE', 'BONK', 'AERO', 'ETH', 'DOGE', 'RAY',
        // EVM chain searches (same query returns the chain's own pairs)
        'USDC', 'WETH', 'WBTC', 'LINK', 'UNI', 'AAVE', 'MKR',
        'BRETT', 'TOSHI', 'DEGEN', 'FARTCOIN', 'MOODENG', // Base memes
      ];
      for (const q of popularQueries) {
        if (addrs.length >= limit * 2) break;
        try {
          const pairs = await dexscreener.search(q);
          for (const p of pairs.slice(0, 2)) push(p.tokenAddress);
        } catch {}
      }
    }

    // 2. ONE batched market snapshot for every candidate (1 HTTP call / 30
    //    addresses). This feeds both the pre-filter and analyzeToken, so the
    //    per-token DexScreener round-trip disappears.
    const snapshot = await dexscreener.tokens(addrs).catch(() => new Map());

    // 3. Deterministic pre-filter BEFORE any LLM spend. Junk that would be
    //    rejected by runRiskAssessment never reaches a Bull/Bear call.
    const candidates = [];
    for (const addr of addrs) {
      if (candidates.length >= limit) break;
      const market = snapshot.get(addr.toLowerCase());
      if (passesPreFilter(market)) candidates.push({ addr, market });
    }

    // 4. Parallel analysis with bounded concurrency. `mapLimit` preserves
    //    order and swallows per-token failures (old try/catch semantics).
    const results = await mapLimit(candidates, concurrency, ({ addr, market }) =>
      analyzeToken(userId, addr, market));
    for (const r of results) add(r);

    const sorted = reports.sort((a, b) => {
      const scoreA = a.verdict.signal.includes('BUY') ? a.verdict.confidence : -a.verdict.confidence;
      const scoreB = b.verdict.signal.includes('BUY') ? b.verdict.confidence : -b.verdict.confidence;
      return scoreB - scoreA;
    });
    // Record signal history (max 200 per user)
    const st = stateFor(userId);
    if (!st.signalHistory) st.signalHistory = [];
    for (const r of sorted) {
      st.signalHistory.unshift({
        ts: Date.now(),
        symbol: r.token.symbol,
        address: r.token.address,
        signal: r.verdict.signal,
        confidence: r.verdict.confidence,
        entryPrice: r.verdict.entryPrice,
        bull: { score: r.agents.bull.score, thesis: r.agents.bull.thesis },
        bear: { score: r.agents.bear.score, risks: r.agents.bear.risks },
        llmPowered: r.llmPowered ?? false,
      });
    }
    if (st.signalHistory.length > 200) st.signalHistory.length = 200;
    // Persist signalHistory + slCooldowns + autopilot config via saveUserState
    saveUserState(userId);

    scanCacheByUser.set(userId, { at: Date.now(), reports: sorted, limit });
    return sorted;
  })().finally(() => {
    scanInFlightByUser.delete(userId);
  });
  scanInFlightByUser.set(userId, promise);
  // Stale-while-revalidate: the radar poll opts in and gets the last good scan
  // instantly while the fresh one runs in the background. A scan takes ~8s
  // (two rounds of LLM calls), and blocking every cache miss on it is exactly
  // what made the 5s poll feel like an 8s refresh.
  if (opts.allowStale && cached) {
    promise.catch(() => {}); // background failure must not become an unhandled rejection
    return cached.reports.slice(0, limit);
  }
  return promise;
}

export function setAutopilot(userId, config) {
  const clamp = (v, dft, min, max) => {
    const n = Number(v);
    if (v === undefined || v === null || Number.isNaN(n)) return dft;
    return Math.min(max, Math.max(min, n));
  };
  const st = stateFor(userId);
  const next = { ...st };
  // Partial-update safe: only fields present in the payload are written.
  // Applying clamp() unconditionally would reset every Guardian setting to its
  // default whenever the UI toggles only `enabled`.
  if (config.enabled !== undefined) next.enabled = Boolean(config.enabled);
  if (config.riskLevel !== undefined) next.riskLevel = ['low', 'medium', 'high'].includes(config.riskLevel) ? config.riskLevel : 'medium';
  if (config.takeProfitPct !== undefined) next.takeProfitPct = clamp(config.takeProfitPct, next.takeProfitPct ?? 15, 1, 500);
  if (config.stopLossPct !== undefined) next.stopLossPct = clamp(config.stopLossPct, next.stopLossPct ?? 7, 1, 50);
  if (config.trailingStopPct !== undefined) next.trailingStopPct = clamp(config.trailingStopPct, next.trailingStopPct ?? 4, 1, 25);
  if (config.trailingTriggerPct !== undefined) next.trailingTriggerPct = clamp(config.trailingTriggerPct, next.trailingTriggerPct ?? 6, 1, 100);
  if (config.moonbagX !== undefined) next.moonbagX = clamp(config.moonbagX, next.moonbagX ?? 2, 1, 10);
  if (config.maxOpenPositions !== undefined) next.maxOpenPositions = Math.round(clamp(config.maxOpenPositions, next.maxOpenPositions ?? 3, 1, 10));
  if (config.minConfidence !== undefined) next.minConfidence = clamp(config.minConfidence, next.minConfidence ?? 75, 1, 100);
  if (config.rotateAfterHours !== undefined) next.rotateAfterHours = clamp(config.rotateAfterHours, next.rotateAfterHours ?? 24, 1, 168);
  if (config.maxExposurePct !== undefined) next.maxExposurePct = clamp(config.maxExposurePct, next.maxExposurePct ?? 80, 10, 100);
  if (config.llmTemperature !== undefined) next.llmTemperature = clamp(config.llmTemperature, next.llmTemperature ?? 0.3, 0, 1);
  if (config.agentMode !== undefined) {
    next.agentMode = ['blend', 'deterministic', 'llm'].includes(config.agentMode) ? config.agentMode : 'blend';
  }
  // NEW: LLM / scan performance knobs
  if (config.llmTimeoutMs !== undefined) next.llmTimeoutMs = Math.round(clamp(config.llmTimeoutMs, next.llmTimeoutMs ?? 30_000, 5_000, 180_000));
  if (config.scanConcurrency !== undefined) next.scanConcurrency = Math.round(clamp(config.scanConcurrency, next.scanConcurrency ?? 3, 1, 6));
  if (config.enableLeadSynthesis !== undefined) next.enableLeadSynthesis = Boolean(config.enableLeadSynthesis);
  autopilotStates.set(userId, next);
  addLog(userId, 'CONFIG', `Konfigurasi Auto-Pilot diperbarui (Status: ${next.enabled ? 'ON' : 'OFF'}, Risk: ${next.riskLevel})`);
  saveUserState(userId);
  return getAutopilot(userId);
}

export function clearAutopilotLogs(userId) {
  stateFor(userId).logs = [];
  saveUserState(userId);
  return { ok: true };
}

export function getAutopilot(userId) {
  const st = stateFor(userId);
  const positions = getPositions(userId);
  const guarded = positions.map((p) => {
    const cur = Number(p.currentPrice) || Number(p.avgBuyPrice) || 0;
    const avg = Number(p.avgBuyPrice) || cur;
    const pnlUsd = (Number(p.amount) || 0) * (cur - avg);
    const pnlPct = avg > 0 ? ((cur - avg) / avg) * 100 : 0;
    const tpPrice = avg * (1 + (st.takeProfitPct ?? 15) / 100);
    const slPrice = avg * (1 - (st.stopLossPct ?? 7) / 100);
    const high = Number(p.highestPrice) || cur;
    const peakPct = avg > 0 ? ((high - avg) / avg) * 100 : 0;
    const isTrailing = peakPct >= (st.trailingTriggerPct ?? 6);

    let status = 'GUARDED';
    if (p.tp1Hit) status = 'MOONBAG_RUNNER';
    else if (isTrailing) status = 'TRAILING_ACTIVE';
    else if (pnlPct >= (st.takeProfitPct ?? 15)) status = 'TP_TRIGGER';
    else if (pnlPct <= -(st.stopLossPct ?? 7)) status = 'SL_TRIGGER';

    return {
      symbol: p.symbol, address: p.tokenAddress, chainId: p.chainId,
      amount: Number(p.amount) || 0, avgBuyPrice: avg, currentPrice: cur,
      highestPrice: high, tp1Hit: Boolean(p.tp1Hit),
      pnlUsd: Math.round(pnlUsd * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100,
      tpPrice, slPrice, status,
    };
  });
  st.guardedPositions = guarded;
  return {
    ...st,
    guardedPositionsCount: guarded.length,
    signalAccuracy: computeSignalAccuracy(st),
    memory: (st.memory ?? []).slice(0, 20),
    nearMisses: (st.nearMisses ?? []).slice(0, 20),
  };
}

/** Run one guardian+scout tick for a single user. Returns {executed, order?, reason?, log?}. */
export async function runAutopilotTick(userId) {
  const st = stateFor(userId);
  if (!st.enabled) { st.status = 'IDLE'; return null; }

  st.status = 'GUARDIAN';
  st.lastScanAt = Date.now();
  st.stats.totalScans++;

  const positions = getPositions(userId);
  const wallet = getWallet(userId);

  // Equity curve must track the ACTIVE wallet, not always the virtual one.
  //   - Real mode + bound MetaMask → on-chain value (native + ERC-20, in USD).
  //   - Otherwise → the virtual paper ledger (historical behaviour).
  const tickTs = Date.now();
  let recordedReal = false;
  if (isRealMode(userId)) {
    try {
      const { getEvmTotalValue, getBoundEvmAddress } = await import('./evmWallet.js');
      const address = getBoundEvmAddress(userId);
      const realTotal = address
        ? await getEvmTotalValue(address, 'base', { tokens: positions.map((p) => p.tokenAddress) })
        : null;
      if (Number.isFinite(realTotal)) {
        st.pnlHistory.push({ ts: tickTs, totalValue: Math.round(realTotal * 100) / 100 });
        if (st.pnlHistory.length > 60) st.pnlHistory.shift();
        recordedReal = true;
      }
    } catch {
      // fall through to virtual value — equity curve must never break a tick
    }
  }

  if (!recordedReal) {
    st.pnlHistory.push({ ts: tickTs, totalValue: Math.round(wallet.totalValue * 100) / 100 });
    if (st.pnlHistory.length > 60) st.pnlHistory.shift();
  }

  // Batch-fetch all position prices once per tick (was 1 HTTP call per position).
  const markets = await dexscreener.tokens(positions.map((p) => p.tokenAddress)).catch(() => new Map());

  // Fill in pending signal outcomes (1h/24h price checks) — cheap, batched.
  await updateSignalOutcomes(userId).catch(() => {});

  // Stale-intent sweep. An intent the user never approved stays 'open' for its
  // full 30-minute TTL, and the scout's hasPendingBuyIntent()/hasPendingSellIntent()
  // refuse to emit a replacement meanwhile — so a token that got one stranded
  // intent is blocked from new signals for the rest of that window. Two jobs:
  //   1. prune SELL intents that can NEVER succeed (wallet holds no such token);
  //   2. remind the user about the rest, throttled, so a browser-closed intent
  //      does not silently expire.
  if (isRealMode(userId)) {
    try {
      const { getEvmTokenBalance, getBoundEvmAddress } = await import('./evmWallet.js');
      const address = getBoundEvmAddress(userId);
      for (const pending of getRealIntents(userId)) {
        if (pending.status !== 'open') continue;
        if (pending.side === 'sell' && address) {
          // The condition is PERMANENT, not transient: retrying is pointless,
          // and the open intent blocks hasPendingSellIntent() for that token,
          // so the guardian could never emit a fresh exit. This is the "phantom
          // position" case — a virtual-mode position mirrored into the ledger
          // while the wallet never actually held the token.
          const held = await getEvmTokenBalance(address, pending.tokenAddress, pending.chainId || 'base').catch(() => null);
          if (held === 0n) {
            addLog(userId, 'WARN', `🧹 Intent SELL ${pending.symbol ?? pending.tokenAddress} di-prune — wallet tidak memegang token ini (posisi phantom). Posisi virtual dibersihkan.`, {
              intentId: pending.id,
              tokenAddress: pending.tokenAddress,
            });
            try { setRealIntentStatus(userId, pending.id, 'cancelled'); } catch {}
            try {
              const { reducePositionAmount } = await import('./wallet.js');
              reducePositionAmount(userId, pending.tokenAddress, Number.MAX_SAFE_INTEGER);
            } catch {}
            intentReminderThrottles.delete(pending.id);
            continue;
          }
        }
        remindPendingApproval(userId, pending);
      }
    } catch (e) {
      addLog(userId, 'WARN', `Sweep intent gagal: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  for (const pos of positions) {
    try {
      const market = markets.get(pos.tokenAddress.toLowerCase());
      if (!market || !market.priceUsd) continue;

      const curPrice = Number(market.priceUsd);
      // DexScreener data is external input; skip a corrupt tick before it can
      // trigger a sell, calculate PnL, or create a real-wallet intent.
      if (!Number.isFinite(curPrice) || curPrice <= 0 || curPrice > 1e12) {
        addLog(userId, 'WARN', `Skip ${pos.symbol}: harga market tidak valid`);
        continue;
      }
      const avgPrice = Number(pos.avgBuyPrice) || curPrice;
      const pnlPct = avgPrice > 0 ? ((curPrice - avgPrice) / avgPrice) * 100 : 0;
      const pnlUsd = (Number(pos.amount) || 0) * (curPrice - avgPrice);
      const tech = runTechnicalAnalysis(market);

      const prevHigh = Number(pos.highestPrice) || avgPrice;
      const highPrice = Math.max(prevHigh, curPrice);
      if (highPrice > prevHigh) updatePositionMetadata(userId, pos.tokenAddress, { highestPrice: highPrice });

      const trailingStopPct = st.trailingStopPct ?? 4;
      const trailingTriggerPct = st.trailingTriggerPct ?? 6;
      const trailingDropPct = highPrice > 0 ? ((highPrice - curPrice) / highPrice) * 100 : 0;
      const peakProfitPct = avgPrice > 0 ? ((highPrice - avgPrice) / avgPrice) * 100 : 0;
      const isTrailingActive = peakProfitPct >= trailingTriggerPct;

      const sellAll = async (tag, msg, cur) => {
        const outcomePct = avgPrice > 0 ? ((cur - avgPrice) / avgPrice) * 100 : 0;
        const estTokens = pos.amount;
        const usdValue = estTokens * cur;

        // Real-wallet mode: emit a pending intent for user approval instead of
        // trading virtual money. Autopilot becomes semi-auto (user taps Approve).
        if (isRealMode(userId)) {
          // Dedup: don't re-emit while a sell intent for this token is pending
          // OR in flight. 'active' means claimed and mid-execution — emitting a
          // second intent there queues a duplicate that auto-execute would run
          // again → double-sell of real tokens.
          const existingOpen = hasPendingSellIntent(userId, pos.tokenAddress);
          if (existingOpen) return { intent: null, skipped: true, executed: false };
          const intent = addRealIntent(userId, {
            symbol: pos.symbol,
            tokenAddress: pos.tokenAddress,
            chainId: pos.chainId,
            side: 'sell',
            source: tag, // 'SL'|'TP'|'TRAILING'|'WARN'
            amountUsd: Math.round(usdValue * 100) / 100,
            estTokens,
            intentPrice: cur,
            // Cost basis snapshot: realIntent.js books realized PnL when this
            // intent is confirmed, by which point the position row is gone.
            entryAvgPrice: avgPrice,
          });
          addLog(userId, tag, `☝️ [${tag} REAL] ${pos.symbol} → intent ${intent.id} menunggu approve di MetaMask @ $${cur}`, intent);
          // No server-side execution: the user signs this in MetaMask. PnL and
          // decision memory are recorded by recordExitOnDone() when the intent
          // actually reaches 'done' — counting them here would book a trade
          // the user may never approve.
          return { intent, executed: false, pending: true };
        }

        const order = executeMarketOrder(userId, {
          side: 'sell', tokenAddress: pos.tokenAddress, chainId: pos.chainId,
          symbol: pos.symbol, name: pos.name, tokenAmount: pos.amount, currentPrice: cur,
        });
        recordRealized(userId, { pnlUsd });
        // Decision memory: enriched entry with market context, exit reason, hold time.
        if (!st.memory) st.memory = [];
        const regime = marketRegime(tech);
        const holdMs = pos.openedAt ? Date.now() - Number(pos.openedAt) : 0;
        st.memory.unshift({
          ts: Date.now(),
          symbol: pos.symbol,
          signal: tag,
          confidence: pnlPct >= 0 ? 100 : 0,
          entryPrice: avgPrice,
          outcomePct: Number(outcomePct.toFixed(1)),
          regime,
          chainId: pos.chainId,
          liquidityUsd: tech.liquidityUsd,
          volume24h: tech.volume24h,
          fdv: tech.fdv,
          buyRatio: tech.buyRatio,
          volToLiqRatio: tech.volToLiqRatio,
          exitReason: tag,
          holdMs,
        });
        if (st.memory.length > 50) st.memory.length = 50;
        addLog(userId, tag, msg, order);
        return { order, executed: true };
      };

      // 1. Partial TP1 (50%)
      if (pnlPct >= (st.takeProfitPct ?? 15) && !pos.tp1Hit) {
        const halfTokens = Number(pos.amount) * 0.5;
        const halfPnlUsd = pnlUsd * 0.5;
        // Real-wallet mode: emit an intent for the user (or auto-approve flow).
        if (isRealMode(userId)) {
          // Dedup: an open/active sell intent for this token already covers it.
          const existingOpen = hasPendingSellIntent(userId, pos.tokenAddress);
          if (!existingOpen) {
            const intent = addRealIntent(userId, {
              symbol: pos.symbol,
              tokenAddress: pos.tokenAddress,
              chainId: pos.chainId,
              side: 'sell',
              source: 'TP1', // distinct from TP2/trailing so the done-handler knows
              amountUsd: Math.round(halfTokens * curPrice * 100) / 100,
              estTokens: halfTokens,
              intentPrice: curPrice,
              // Captured at emit time: the done-handler needs the cost basis
              // after reducePositionAmount has already deleted the position.
              entryAvgPrice: avgPrice,
            });
            addLog(userId, 'TP', `☝️ [PARTIAL TP 50% REAL] ${pos.symbol} → intent ${intent.id} menunggu approve di MetaMask @ $${curPrice} (+${pnlPct.toFixed(1)}%)`, intent);
            // PnL and tp1Hit are applied by realIntent.js when this intent
            // reaches 'done'. Do NOT set tp1Hit here: the user may cancel this
            // intent, and a cancelled TP must not arm the moonbag TP2 path.
          }
          // NEVER execute a virtual trade while real mode is on. No `continue`
          // here, so the stop-loss / trailing / defensive checks below still run
          // this tick — a pending TP intent must not mask a stop-loss.
        } else {
          const order = executeMarketOrder(userId, {
            side: 'sell', tokenAddress: pos.tokenAddress, chainId: pos.chainId,
            symbol: pos.symbol, name: pos.name, tokenAmount: halfTokens, currentPrice: curPrice,
          });
          // Virtual branch: there is no intent here, so key on the order id —
          // reading `intent.id` in this scope was a ReferenceError that aborted
          // the partial TP1 before it could be recorded.
          recordRealized(userId, { pnlUsd: halfPnlUsd, intentId: null, key: order.id });
          addLog(userId, 'TP', `🎯 [PARTIAL TP 50%] Amankan 50% profit ${pos.symbol} @ $${curPrice} (+${pnlPct.toFixed(1)}% | +$${halfPnlUsd.toFixed(2)} USDC). Sisa 50% jadi Moonbag Runner!`, order);
          updatePositionMetadata(userId, pos.tokenAddress, { tp1Hit: true });
          continue;
        }
      }

      // 2. Trailing stop
      if (isTrailingActive && trailingDropPct >= trailingStopPct) {
        const exit = await sellAll('TP', `🔒 [TRAILING STOP] Mengunci profit ${pos.symbol} @ $${curPrice} (Peak: $${highPrice.toFixed(4)}, Net: +${pnlPct.toFixed(1)}% | +$${pnlUsd.toFixed(2)} USDC)`, curPrice);
        if (exit?.executed && pnlPct < 0) setSlCooldown(userId, pos.tokenAddress); // loss exit → cooldown
        continue;
      }

      // 3. TP2 moonbag
      const tp2Target = (st.takeProfitPct ?? 15) * (st.moonbagX ?? 2);
      if (pos.tp1Hit && pnlPct >= tp2Target) {
        const exit = await sellAll('TP', `🚀 [MOONBAG TP2 +${pnlPct.toFixed(1)}%] Tutup sisa posisi ${pos.symbol} @ $${curPrice} (Profit +$${pnlUsd.toFixed(2)} USDC)`, curPrice);
        if (exit?.executed) updatePositionMetadata(userId, pos.tokenAddress, { tp1Hit: false }); // reset for any re-entry
        continue;
      }

      // 4. Hard stop loss
      if (pnlPct <= -(st.stopLossPct ?? 7)) {
        const exit = await sellAll('SL', `🛑 [STOP LOSS ${pnlPct.toFixed(1)}%] Auto-cut ${pos.symbol} @ $${curPrice} (Loss -$${Math.abs(pnlUsd).toFixed(2)} USDC)`, curPrice);
        if (exit?.executed) setSlCooldown(userId, pos.tokenAddress);
        continue;
      }

      // 5. AI emergency bear dump protection — non-blocking: stale cache is
      // acceptable for a defensive signal; the worst case is a one-tick delay.
      try {
        const aiAudit = await getCachedAudit(userId, pos.tokenAddress, { allowBlocking: false });
        if (aiAudit && aiAudit.agents.bear.score >= 80 && pnlPct < 0) {
          const exit = await sellAll('WARN', `🛡️ [DEFENSIVE EXIT] Bear risk melonjak 80%+. Auto-sell ${pos.symbol} @ $${curPrice} (Loss -$${Math.abs(pnlUsd).toFixed(2)} USDC)`, curPrice);
          if (exit?.executed) setSlCooldown(userId, pos.tokenAddress);
        }
      } catch {}
    } catch (e) {
      addLog(userId, 'WARN', `Gagal audit posisi ${pos.symbol}: ${e.message}`);
    }
  }

  // Phase 2: scout for new buys (signal quality + exposure/correlation guards)
  st.status = 'SCANNING';
  const currentOpenPositions = getPositions(userId).length;
  const slotsFull = currentOpenPositions >= (st.maxOpenPositions ?? 3);
  if (slotsFull) {
    // Slot full → try rotation of a stagnant position to free capacity.
    // Reuses the tick's price snapshot — no extra DexScreener round-trip.
    await rotateStagnant(userId, markets);
    if (getPositions(userId).length >= (st.maxOpenPositions ?? 3)) {
      addLog(userId, 'SCAN', `Slot posisi penuh (${currentOpenPositions}/${st.maxOpenPositions}). Guardian tetap aktif memantau.`);
      st.status = 'IDLE';
      return { executed: false, reason: 'MAX_POSITIONS' };
    }
  }
  // --- Real-mode aware balance/exposure gates ---------------------------------
  // In real mode, sizing/scout gates must read the bound MetaMask address's
  // on-chain value, not the virtual paper ledger — otherwise a drained wallet
  // keeps getting buy intents that fail, or an over-exposed wallet is let
  // through because the virtual balance never falls.
  let realTotalUsd = null;
  let realTokenUsd = null;
  let boundAddress = null;
  if (isRealMode(userId)) {
    try {
      const { getEvmTotalValue, getEvmTokenValue, getBoundEvmAddress } = await import('./evmWallet.js');
      boundAddress = getBoundEvmAddress(userId);
      if (boundAddress) {
        const tokens = getPositions(userId).map((p) => p.tokenAddress);
        realTotalUsd = await getEvmTotalValue(boundAddress, 'base', { tokens });
        realTokenUsd = (await getEvmTokenValue(boundAddress, 'base', tokens)).valueUsd;
      }
    } catch {
      // keep null → gates fall back to virtual (never break the tick)
    }
  }

  // LOW_BALANCE: below MIN_TRADEABLE_USD there is nothing worth buying into and
  // no room to cover fees, so stop scouting and let TP/SL drain the book. Real
  // mode reads the bound wallet's on-chain USD value (native + ERC-20); virtual
  // mode reads the paper ledger. The gas reserve itself is enforced in
  // checkEvmAffordability (EVM_FEE_RESERVE_NATIVE), not here.
  const MIN_TRADEABLE_USD = 5;
  const totalForBalance = isRealMode(userId) && realTotalUsd !== null ? realTotalUsd : wallet.balance;
  if (totalForBalance < MIN_TRADEABLE_USD) {
    const prefix = isRealMode(userId) ? 'Nilai wallet' : 'Saldo virtual';
    addLog(userId, 'SCAN', `${prefix} $${totalForBalance.toFixed(2)} < $${MIN_TRADEABLE_USD}. Menunggu take-profit / isi ulang.`);
    st.status = 'IDLE';
    return { executed: false, reason: 'LOW_BALANCE' };
  }

  // EXPOSURE_LIMIT: what fraction of the book is already at risk, as a % of
  // total value. BOTH sides must come from the same source or the ratio is
  // meaningless. Real mode: numerator = on-chain ERC-20 value (the native coin
  // is undeployed cash/gas, not exposure), denominator = on-chain total.
  // Virtual mode: both from the paper ledger, positions + reserved over total.
  const maxExposurePct = st.maxExposurePct ?? 80;
  let exposure;
  let totalForExposure;
  if (isRealMode(userId) && realTotalUsd !== null) {
    exposure = Number.isFinite(realTokenUsd) ? realTokenUsd : wallet.totalPositionValue;
    totalForExposure = realTotalUsd;
  } else {
    exposure = wallet.totalPositionValue + (wallet.reservedUsd ?? 0);
    totalForExposure = wallet.totalValue;
  }
  if (totalForExposure > 0 && (exposure / totalForExposure) * 100 >= maxExposurePct) {
    addLog(userId, 'SCAN', `Exposure limit ${maxExposurePct}% tercapai (${Math.round((exposure / totalForExposure) * 100)}% dari $${totalForExposure.toFixed(2)}). Skip scout.`);
    st.status = 'IDLE';
    return { executed: false, reason: 'EXPOSURE_LIMIT' };
  }

  try {
    const signals = await scanMarketSignals(userId, 5);
    const nowTs = Date.now();
    const cooldowns = st.slCooldowns ?? {};
    const qualifies = (s) =>
      (s.verdict.signal === 'STRONG_BUY' || s.verdict.signal === 'BUY') &&
      s.verdict.confidence >= (st.minConfidence ?? 75);
    // Near-miss: strong signal skipped by a constraint (cooldown / held / chain cap).
    for (const s of signals) {
      if (!qualifies(s)) continue;
      const held = positions.some((p) => p.tokenAddress.toLowerCase() === s.token.address.toLowerCase());
      const chainCount = positions.filter((p) => p.chainId === s.token.chainId).length;
      if (held) continue; // already ours — not a miss
      if (cooldowns[s.token.address] > nowTs) recordNearMiss(userId, s, 'SL_COOLDOWN');
      else if (chainCount >= 2) recordNearMiss(userId, s, 'CORRELATION');
    }
    const topBuy = signals.find(
      (s) => qualifies(s) &&
             !positions.some((p) => p.tokenAddress.toLowerCase() === s.token.address.toLowerCase()) &&
             !(cooldowns[s.token.address] > nowTs) &&
             // chain correlation: max 2 positions on the same chain
             positions.filter((p) => p.chainId === s.token.chainId).length < 2
    );
    if (topBuy) {
      const { token, verdict } = topBuy;
      const tier = verdict.signal === 'STRONG_BUY' ? 1 : 0.5; // BUY → 50% size
      // Guard: a scan result with a missing/NaN recommendedUsd (stale cache entry,
      // a report built before the balance was known) must not propagate NaN into
      // the affordability check — it surfaced as "$undefined (BAD_AMOUNT) — skip".
      const rawUsd = Number(verdict.recommendedUsd);
      const baseUsd = Number.isFinite(rawUsd) && rawUsd > 0 ? rawUsd : 10;
      const usdAmount = Math.round(baseUsd * tier * 100) / 100;

      // Real-wallet mode: emit intent for the user to approve in MetaMask.
      if (isRealMode(userId)) {
        // EVM-only execution. A non-EVM token can never be filled — 1inch has
        // no Solana route — so emitting it would strand an 'open' intent and
        // block this token's dedup. Defense-in-depth behind passesPreFilter
        // (signals can come from other paths, e.g. a manual analyze that skips
        // the scanner).
        if (!isSupportedChain(token.chainId)) {
          addLog(userId, 'WARN', `⚠️ [${verdict.signal} REAL] ${token.symbol}: chain "${token.chainId ?? 'unknown'}" tidak didukung (hanya EVM) — intent tidak dibuat`, { tokenAddress: token.address });
          st.status = 'IDLE';
          return { executed: false, reason: 'UNSUPPORTED_CHAIN' };
        }

        // Prevent double-buy on the same token: an open/active intent already
        // in flight means the user (or hot-wallet) hasn't finished it yet.
        // The autopilot ticks every 5s, so without this check a second intent
        // is emitted on the next tick → two real buys of the same token.
        if (hasPendingBuyIntent(userId, token.address)) {
          addLog(userId, 'WARN', `⚠️ [${verdict.signal} REAL] ${token.symbol}: intent buy sudah ada (open/active) — skip emit ulang`, { tokenAddress: token.address });
          st.status = 'IDLE';
          return { executed: false, reason: 'PENDING_BUY_INTENT' };
        }

        // Never interpret a USD budget as a native-coin amount. Convert via the
        // live native/USD spot price; refuse to emit when unknown (the swap-tx
        // builder cannot work out a safe amount without it).
        const { getNativeUsdPrice, checkTradeSize, checkEvmAffordability } = await import('./evmWallet.js');
        const nativeUsd = await getNativeUsdPrice(token.chainId);
        if (!nativeUsd || nativeUsd <= 0) {
          addLog(userId, 'WARN', `⛔ [${verdict.signal} REAL] ${token.symbol}: harga ${getChainConfig(token.chainId).native} tidak tersedia — buy intent dibatalkan (mencegah salah unit)`, { usdAmount });
          st.status = 'IDLE';
          return { executed: false, reason: 'NO_NATIVE_PRICE' };
        }
        if (!boundAddress) {
          addLog(userId, 'WARN', `⛔ [${verdict.signal} REAL] ${token.symbol}: wallet belum di-bind — bind MetaMask dulu di Settings`, { usdAmount });
          st.status = 'IDLE';
          return { executed: false, reason: 'NO_BOUND_WALLET' };
        }
        // Clamp to the per-trade cap. `usdAmount` comes from the VIRTUAL
        // wallet's balance (risk.maxUsdPosition), which is usually far larger
        // than real funds — an unclamped intent is rejected by checkTradeSize()
        // and the trade is silently lost.
        const capped = checkTradeSize(usdAmount);
        let effectiveUsd = capped.ok ? usdAmount : capped.cap;
        if (!capped.ok) {
          addLog(userId, 'WARN', `⚠️ [${verdict.signal} REAL] ${token.symbol}: posisi $${usdAmount} dipangkas ke cap $${capped.cap}`, { originalUsd: usdAmount, cappedUsd: capped.cap });
        }
        // REAL affordability: don't emit a buy the wallet cannot pay for. The
        // virtual ledger's balance says "plenty"; the MetaMask balance is the
        // only real number. Downsize to what is actually spendable after the
        // gas reserve, else skip — a doomed intent would otherwise sit 'open'
        // and block this token's dedup until it expires.
        const afford = await checkEvmAffordability(boundAddress, effectiveUsd, { nativeUsd, chain: token.chainId });
        if (!afford.ok) {
          addLog(userId, 'WARN', `⛔ [${verdict.signal} REAL] ${token.symbol}: wallet tidak sanggup beli $${effectiveUsd} (${afford.reason}) — skip`, { balanceNative: afford.balanceNative, reason: afford.reason });
          st.status = 'IDLE';
          return { executed: false, reason: afford.reason };
        }
        if (afford.buyUsd < effectiveUsd) {
          effectiveUsd = Math.round(afford.buyUsd * 100) / 100;
          addLog(userId, 'WARN', `⚠️ [${verdict.signal} REAL] ${token.symbol}: ukuran diturunkan ke $${effectiveUsd} agar muat wallet (${afford.balanceNative.toFixed(4)} ${getChainConfig(token.chainId).native}, ±${afford.reserveNative.toFixed(4)} dicadangkan fee)`, { balanceNative: afford.balanceNative, buyUsd: effectiveUsd });
        }
        const amountWei = Math.round((effectiveUsd / nativeUsd) * 1e18);
        const intent = addRealIntent(userId, {
          symbol: token.symbol,
          tokenAddress: token.address,
          chainId: token.chainId,
          side: 'buy',
          source: verdict.signal, // 'STRONG_BUY' | 'BUY'
          amountUsd: effectiveUsd,
          amountWei,
          estTokens: verdict.recommendedTokens,
          intentPrice: verdict.entryPrice,
          // Agent/LLM provenance — the UI must show WHY this is worth approving,
          // never an anonymous "approve this" prompt.
          confidence: verdict.confidence,
          llmPowered: topBuy.llmPowered ?? false,
          bullScore: topBuy.agents?.bull ?? null,
          bearScore: topBuy.agents?.bear ?? null,
        });
        addLog(userId, 'BUY', `☝️ [${verdict.signal} REAL] ${token.symbol} → intent ${intent.id} ($${effectiveUsd} ≈ ${(amountWei / 1e18).toFixed(6)} ${getChainConfig(token.chainId).native}) menunggu approve di MetaMask @ $${verdict.entryPrice}`, intent);
        st.status = 'IDLE';
        // Emitted, not executed: the user signs in MetaMask. The position is
        // mirrored by realIntent.js when this intent reaches 'done'.
        return { executed: false, intent, pending: true };
      }

      const order = executeMarketOrder(userId, {
        side: 'buy', tokenAddress: token.address, chainId: token.chainId,
        symbol: token.symbol, name: token.name, usdAmount,
        tokenAmount: 0, // derive from usdAmount / entryPrice server-side
        currentPrice: verdict.entryPrice,
      });
      const label = tier === 1 ? 'AUTO-BUY' : 'AUTO-BUY 50%';
      addLog(userId, 'BUY', `🚀 [${label}] ${token.symbol} @ $${verdict.entryPrice} ($${usdAmount} USDC | ${verdict.signal} ${verdict.confidence}%)`, order);
      st.status = 'IDLE';
      return { executed: true, order };
    } else {
      addLog(userId, 'SCAN', `Radar memindai 5 pool: belum ada sinyal BUY/STRONG_BUY >= ${st.minConfidence}%. Scanning berikutnya dalam 5s.`);
    }
  } catch (e) {
    addLog(userId, 'WARN', `Error pemindaian radar: ${e.message}`);
  }

  st.status = 'IDLE';
  return { executed: false };
}

/**
 * Update signal outcomes: for history entries older than 1h/24h that lack a
 * price snapshot, batch-fetch prices and fill price1h/price24h.
 */
async function updateSignalOutcomes(userId) {
  const st = stateFor(userId);
  const hist = st.signalHistory ?? [];
  const now = Date.now();
  const pending = hist.filter((h) =>
    (!h.price1h && now - h.ts >= 3_600_000) ||
    (!h.price24h && now - h.ts >= 24 * 3_600_000),
  );
  if (pending.length === 0) return;
  const markets = await dexscreener.tokens([...new Set(pending.map((h) => h.address))]).catch(() => new Map());
  let changed = false;
  for (const h of pending) {
    const m = markets.get(h.address.toLowerCase());
    if (!m?.priceUsd) continue;
    if (!h.price1h && now - h.ts >= 3_600_000) { h.price1h = m.priceUsd; changed = true; }
    if (!h.price24h && now - h.ts >= 24 * 3_600_000) { h.price24h = m.priceUsd; changed = true; }
  }
  if (changed) saveUserState(userId);
}

/** Map technical trend + volatility into a coarse market regime bucket. */
function marketRegime(tech) {
  const t = String(tech.trend ?? 'NEUTRAL');
  if (t.includes('BULLISH') || t === 'MOMENTUM_BREAKOUT') {
    return tech.volToLiqRatio >= 2 ? 'volatile' : 'trending_up';
  }
  if (t.includes('BEARISH')) {
    return tech.volToLiqRatio >= 2 ? 'volatile' : 'trending_down';
  }
  return tech.volToLiqRatio >= 2 ? 'volatile' : 'ranging';
}

/**
 * Build the memory block injected into Bull/Bear prompts. Two-tier selection:
 * entries matching this token's chain + regime first, then recent fill-up.
 * Adds an aggregate pattern line when enough same-regime samples exist.
 */
function buildMemoryBlock(st, market, tech) {
  const all = st.memory ?? [];
  if (all.length === 0) return '';

  const regime = marketRegime(tech);
  const chainId = market.chainId;
  const relevant = all.filter((m) => m.regime === regime && m.chainId === chainId).slice(0, 5);
  const chosen = [...relevant];
  for (const m of all) {
    if (chosen.length >= 8) break;
    if (!chosen.includes(m)) chosen.push(m);
  }

  const line = (m) =>
    `- ${m.symbol}: called ${m.signal} @ $${m.entryPrice} → ${m.outcomePct >= 0 ? '+' : ''}${Number(m.outcomePct).toFixed(1)}% (${m.outcomePct >= 0 ? 'worked' : 'failed'})${m.exitReason ? ` [${m.exitReason}${m.holdMs ? `, ${Math.round(m.holdMs / 3_600_000)}h` : ''}]` : ''}`;

  let block = `\n\nPast decisions with REALIZED outcomes (learn from these):\n${chosen.map(line).join('\n')}`;

  // Aggregate pattern line — only when we have a real sample of same-regime trades.
  const sameRegime = all.filter((m) => m.regime === regime);
  if (sameRegime.length >= 5) {
    const wins = sameRegime.filter((m) => m.outcomePct > 0).length;
    const avg = sameRegime.reduce((s, m) => s + Number(m.outcomePct || 0), 0) / sameRegime.length;
    block += `\n\nPattern: in ${regime} ${chainId} markets, ${sameRegime.length} trades → ${Math.round((wins / sameRegime.length) * 100)}% win, avg ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%.`;
  }
  return block;
}

/** Compact calibration line from signal accuracy — injected next to the memory block. */
function buildAccuracyBlock(st) {
  const acc = computeSignalAccuracy(st);
  if (acc.n1h === 0) return '';
  const parts = Object.entries(acc.bySignal ?? {})
    .filter(([, v]) => v.n1h > 0)
    .map(([sig, v]) => `${sig.replace('_', ' ')} ${Math.round((v.win1h / v.n1h) * 100)}% @1h (n=${v.n1h})`);
  if (parts.length === 0) return '';
  return `\n\nRecent signal calibration: ${parts.join('; ')}. Adjust confidence accordingly — do not repeat setups that recently failed.`;
}

/** Aggregate accuracy stats from signal history. */
function computeSignalAccuracy(st) {
  const hist = (st.signalHistory ?? []).filter((h) => h.entryPrice > 0);
  const isWin = (h, price) => {
    if (!price) return null;
    return h.signal.includes('BUY') ? price > h.entryPrice : h.signal === 'SELL' ? price < h.entryPrice : null;
  };
  const acc = { total: hist.length, win1h: 0, n1h: 0, win24h: 0, n24h: 0, bySignal: {} };
  for (const h of hist) {
    const key = h.signal;
    acc.bySignal[key] = acc.bySignal[key] ?? { n: 0, win1h: 0, n1h: 0 };
    acc.bySignal[key].n++;
    const w1 = isWin(h, h.price1h);
    const w24 = isWin(h, h.price24h);
    if (w1 !== null) { acc.n1h++; if (w1) acc.win1h++; acc.bySignal[key].n1h++; if (w1) acc.bySignal[key].win1h++; }
    if (w24 !== null) { acc.n24h++; if (w24) acc.win24h++; }
  }
  acc.acc1h = acc.n1h > 0 ? Math.round((acc.win1h / acc.n1h) * 100) : null;
  acc.acc24h = acc.n24h > 0 ? Math.round((acc.win24h / acc.n24h) * 100) : null;
  return acc;
}

/** Kick off a background refresh for `key`, deduped per key. Never awaited by
 *  the tick — failures are logged and the stale entry stays usable. */
function refreshAuditInBackground(userId, tokenAddress, key) {
  const hit = auditCache.get(key);
  if (hit?.refreshing) return; // one refresh in flight per token
  if (hit) hit.refreshing = true; else auditCache.set(key, { ts: 0, report: null, refreshing: true });
  analyzeToken(userId, tokenAddress)
    .then((report) => {
      if (!report) { auditCache.delete(key); return; }
      auditCache.set(key, { ts: Date.now(), report });
      if (auditCache.size > 50) { const first = auditCache.keys().next().value; if (first) auditCache.delete(first); }
    })
    .catch(() => {
      // Keep the stale report if we have one; drop the placeholder otherwise.
      const cur = auditCache.get(key);
      if (cur && !cur.report) auditCache.delete(key);
      else if (cur) cur.refreshing = false;
    });
}

/**
 * Stale-while-revalidate audit cache.
 *
 * Fresh (< AUDIT_TTL): returned as-is.
 * Stale (< AUDIT_STALE_TTL): the cached report is returned IMMEDIATELY and a
 * background refresh is started — the guardian tick never awaits an LLM call.
 * Missing/too old: awaited once (first sight of a token has no data to serve),
 * which is the only path that can block, and only for a brand-new position.
 */
async function getCachedAudit(userId, tokenAddress, { allowBlocking = true } = {}) {
  const key = `${userId}:${tokenAddress}`;
  const hit = auditCache.get(key);
  const age = hit ? Date.now() - hit.ts : Infinity;

  if (hit?.report && age < AUDIT_TTL) return hit.report;
  if (hit?.report && age < AUDIT_STALE_TTL) {
    refreshAuditInBackground(userId, tokenAddress, key); // fire-and-forget
    return hit.report;
  }
  // No usable report yet.
  if (!allowBlocking) {
    refreshAuditInBackground(userId, tokenAddress, key);
    return null;
  }
  const report = await analyzeToken(userId, tokenAddress).catch(() => null);
  if (report) {
    auditCache.set(key, { ts: Date.now(), report });
    if (auditCache.size > 50) { const first = auditCache.keys().next().value; if (first) auditCache.delete(first); }
  }
  return report;
}

/** Mark a token as SL-cooldown: scout skips it for 30 minutes. */
function setSlCooldown(userId, tokenAddress) {
  const st = stateFor(userId);
  if (!st.slCooldowns) st.slCooldowns = {};
  st.slCooldowns[tokenAddress] = Date.now() + 30 * 60_000;
  saveUserState(userId);
}

/**
 * True when a SELL intent for this token is still in flight — 'open' (awaiting
 * approval) OR 'active' (claimed, mid-execution). Checking only 'open' lets a
 * duplicate queue while the first is being signed, and auto-execute would then
 * run both → double-sell of real tokens.
 */
function hasPendingSellIntent(userId, tokenAddress) {
  return getRealIntents(userId).some(
    (i) => (i.status === 'open' || i.status === 'active')
      && i.tokenAddress === tokenAddress
      && i.side === 'sell',
  );
}

/**
 * True when a BUY intent for this token is still in flight. Symmetric with
 * hasPendingSellIntent and equally load-bearing: the autopilot ticks every 5s,
 * so an un-deduped buy re-emits on the next tick whenever the first intent is
 * not yet `done` (hot-wallet auto OFF, or an execution still in flight). Two
 * live buy intents for the same token = two real on-chain buys → double spend.
 * The "already held" check in the scout cannot catch this: the position only
 * appears in the virtual book after the intent reaches `done`.
 */
function hasPendingBuyIntent(userId, tokenAddress) {
  return getRealIntents(userId).some(
    (i) => (i.status === 'open' || i.status === 'active')
      && i.tokenAddress === tokenAddress
      && i.side === 'buy',
  );
}

/** Record a strong signal the scout could not act on (dedup 10 min per token). */
function recordNearMiss(userId, s, reason) {
  const st = stateFor(userId);
  if (!st.nearMisses) st.nearMisses = [];
  const dup = st.nearMisses.find((m) => m.address === s.token.address && Date.now() - m.ts < 600_000);
  if (dup) return;
  st.nearMisses.unshift({
    ts: Date.now(),
    symbol: s.token.symbol,
    address: s.token.address,
    chainId: s.token.chainId,
    signal: s.verdict.signal,
    confidence: s.verdict.confidence,
    entryPrice: s.verdict.entryPrice,
    reason,
  });
  if (st.nearMisses.length > 30) st.nearMisses.length = 30;
}

/**
 * Stagnant rotation: when all slots are full, free one by selling a position
 * that has been flat (-2%..+2%) for longer than `rotateAfterHours`.
 * Prices come from the tick's `markets` snapshot when available (no extra
 * DexScreener call); falls back to pos.currentPrice.
 * Returns the sold symbol or null.
 */
async function rotateStagnant(userId, markets = new Map()) {
  const st = stateFor(userId);
  const hours = st.rotateAfterHours ?? 24;
  const maxAge = hours * 3_600_000;
  const now = Date.now();
  const positions = getPositions(userId);
  for (const pos of positions) {
    const openedAt = Number(pos.openedAt);
    if (!openedAt || now - openedAt < maxAge) continue;
    const fresh = markets.get(pos.tokenAddress.toLowerCase());
    const cur = Number(fresh?.priceUsd) || Number(pos.currentPrice) || Number(pos.avgBuyPrice) || 0;
    const avg = Number(pos.avgBuyPrice) || cur;
    const pnlPct = avg > 0 ? ((cur - avg) / avg) * 100 : 0;
    if (pnlPct < -2 || pnlPct > 2) continue; // not stagnant
    try {
      // Real-wallet mode: emit an intent (rotation hasn't really sold yet).
      if (isRealMode(userId)) {
        // Don't re-emit while a sell intent for this token is pending
        // (open OR active — rotation shouldn't double-queue a sell).
        const dup = hasPendingSellIntent(userId, pos.tokenAddress);
        if (dup) return null;
        const intent = addRealIntent(userId, {
          symbol: pos.symbol,
          tokenAddress: pos.tokenAddress,
          chainId: pos.chainId,
          side: 'sell',
          source: 'ROTATE',
          amountUsd: Math.round(Number(pos.amount) * cur * 100) / 100,
          estTokens: Number(pos.amount),
          intentPrice: cur,
          entryAvgPrice: avg,
        });
        addLog(userId, 'ROTATE', `🔄 [ROTASI REAL] ${pos.symbol} stagnant ${hours}j (${pnlPct.toFixed(1)}%) → intent ${intent.id} menunggu approve di MetaMask @ $${cur}`, intent);
        // No server-side rotation: the slot frees only once the user approves.
        return pos.symbol;
      }
      const order = executeMarketOrder(userId, {
        side: 'sell', tokenAddress: pos.tokenAddress, chainId: pos.chainId,
        symbol: pos.symbol, name: pos.name, tokenAmount: pos.amount, currentPrice: cur,
      });
      // Decision memory: rotation exit also counts as a realized outcome.
      if (!st.memory) st.memory = [];
      st.memory.unshift({
        ts: Date.now(),
        symbol: pos.symbol,
        signal: 'ROTATE',
        confidence: 50,
        entryPrice: avg,
        outcomePct: Number(pnlPct.toFixed(1)),
        regime: 'ranging',
        chainId: pos.chainId,
        exitReason: 'ROTATE',
        holdMs: now - openedAt,
      });
      if (st.memory.length > 50) st.memory.length = 50;
      addLog(userId, 'ROTATE', `🔄 [ROTASI] ${pos.symbol} stagnant ${hours}j (${pnlPct.toFixed(1)}%) — slot dibebaskan @ $${cur}`, order);
      return pos.symbol;
    } catch {}
  }
  return null;
}