// Change fingerprints for the SSE channels — pure functions, zero imports.
//
// These live apart from agentStream.js for one reason: agentStream.js imports
// aiAgent/llmClient/auth/security, so its signature functions cannot be loaded
// by frontend/scripts/agentStream.check.mts. That is why the frontend check used
// to keep a HAND-COPIED mirror of autopilotSignature and tie the two together
// with a substring scan over four field names — a copy that passes while the
// real function changes is worse than no test, because it reports coverage it
// does not have. Keeping the functions here, import-free, lets the check call
// the real ones. Delete this file only if the signatures go away with it.
//
// Nothing here may import anything. A signature that needs app state has stopped
// being a fingerprint and started being a second source of truth.

/**
 * Cheap fingerprint of the guardian state. Anything the UI renders must appear
 * here or the change is never pushed and the page silently freezes — which is
 * the exact failure this module can introduce, so the field list is pinned by
 * frontend/scripts/agentStream.check.mts.
 *
 * The other half of that rule: a field the UI does NOT render must stay out.
 * This function's whole purpose is to make `pushForUser`'s comparison mean
 * "something on screen changed". A field that moves every tick without being
 * drawn makes the comparison always false, so every sweep re-serializes the
 * full autopilot payload for every open tab and the dedupe never fires — a
 * silent cost regression that still looks like the feature is working.
 *
 * `lastScanAt` and `pnlHistory[].ts` were both exactly that: rewritten on every
 * tick, and rendered nowhere (Agents.tsx shows only the point COUNT and
 * totalValue). Together they cost a full ~180 KB payload per subscriber per 5s
 * and bought nothing.
 *
 * @param {any} ap the autopilot snapshot from getAutopilot
 * @returns {string}
 */
export function autopilotSignature(ap) {
  const logs = ap?.logs ?? [];
  const last = logs.length ? logs[0] : null;
  const eq = ap?.pnlHistory ?? [];
  const lastEq = eq.length ? eq[eq.length - 1] : null;
  return [
    ap?.enabled ? 1 : 0,
    ap?.status ?? '',
    logs.length,
    last ? last.ts : 0,
    ap?.guardedPositionsCount ?? 0,
    // Price moves change guarded PnL without touching any of the above.
    (ap?.guardedPositions ?? []).map((p) => `${p.address}${p.pnlPct}${p.status}${p.missingTicks}`).join(','),
    // Count is rendered (the "N titik" caption); totalValue is rendered (the
    // chart trace). The point's timestamp only positions the x-axis by INDEX,
    // so a new point at the same value is not a visible change.
    eq.length,
    lastEq ? lastEq.totalValue : '',
    ap?.stats?.totalTrades ?? 0,
    ap?.stats?.totalProfitUsd ?? 0,
    // The accuracy table renders signalOutcomes. A fresh scan row or a resolved
    // 1h/24h outcome changes this array while logs/positions/stats stay put, so
    // without it the table freezes until some unrelated field happens to move.
    (ap?.signalOutcomes ?? []).map((o) => `${o.address}:${o.ts}:${o.signal}:${o.confidence}:${o.entryPrice}:${o.price1h ?? ''}:${o.price24h ?? ''}`).join(','),
  ].join('|');
}

/**
 * Fingerprint of the radar list. The table renders SIX fields per row —
 * symbol, chainId, priceUsd, signal, confidence, targetPrice — so all six must
 * appear here, and nothing else may.
 *
 * `targetPrice` was missing, and its absence was invisible: it is derived from
 * the entry price (`aiAgent.js` computes it as `priceUsd * (1 +
 * takeProfitPct/100)`), so it moves exactly when `entryPrice` moves and the
 * dedupe fired as normal. The one case where they diverge is the user changing
 * `takeProfitPct` in the Guardian drawer — that rewrites every visible Target
 * TP column while `entryPrice` stays byte-identical, so the whole radar was
 * silently discarded and the column froze at the old setting.
 *
 * symbol/chainId are omitted: for a fixed address DexScreener returns the same
 * pair on every scan, so they are not a per-tick change. Add them if that stops
 * being true rather than preemptively.
 *
 * @param {any[]} reports the radar rows from scanMarketSignals
 * @returns {string}
 */
export function signalsSignature(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return 'empty';
  return reports
    .map((r) => `${r.token.address}:${r.verdict.signal}:${r.verdict.confidence}:${Number(r.verdict.entryPrice ?? 0).toFixed(8)}:${Number(r.verdict.targetPrice ?? 0).toFixed(8)}`)
    .join('|');
}