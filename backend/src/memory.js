// Decision memory — how past outcomes are fed back into the next prompt.
//
// Extracted from aiAgent.js. Pure functions over the user's `memory` and
// `signalHistory` arrays: no state, no network, no userId. The arrays live in
// the persisted autopilot slice and are read by the caller.
// Imported by aiAgent.js (analyzeToken's prompt blocks, getAutopilot's stats).

/** Map technical trend + volatility into a coarse market regime bucket. */
export function marketRegime(tech) {
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
export function buildMemoryBlock(st, market, tech) {
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
export function buildAccuracyBlock(st) {
  const acc = computeSignalAccuracy(st);
  if (acc.n1h === 0) return '';
  const parts = Object.entries(acc.bySignal ?? {})
    .filter(([, v]) => v.n1h > 0)
    .map(([sig, v]) => `${sig.replace('_', ' ')} ${Math.round((v.win1h / v.n1h) * 100)}% @1h (n=${v.n1h})`);
  if (parts.length === 0) return '';
  return `\n\nRecent signal calibration: ${parts.join('; ')}. Adjust confidence accordingly — do not repeat setups that recently failed.`;
}

/** Aggregate accuracy stats from signal history. */
export function computeSignalAccuracy(st) {
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
