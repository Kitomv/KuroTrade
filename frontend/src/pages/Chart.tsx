import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { IconChartLine, IconPause, IconPlay } from '../components/Icons';
import { WatchEntry } from '../api/client';
import { fmt } from '../lib/format';

export function Chart() {
  const [tokenAddr, setTokenAddr] = useState('');
  const [chain, setChain] = useState('solana');
  const [history, setHistory] = useState<{ priceUsd: number; ts: number }[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const entriesP = usePolling(
    () => api.watchlist(),
    30_000,
    [],
  );
  const entries = entriesP.data;

  const loadHistory = useCallback(async (addr: string, chainId: string) => {
    if (!addr.trim()) return;
    setLoadingHistory(true);
    try {
      const h = await api.history(chainId, addr.trim());
      setHistory(h);
    } catch {
      setHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Auto-select first watchlist item if none selected
  useEffect(() => {
    if (!tokenAddr && entries && entries.length > 0) {
      const first = entries[0];
      setTokenAddr(first.tokenAddress);
      setChain(first.chainId);
      loadHistory(first.tokenAddress, first.chainId);
    }
  }, [entries, loadHistory]);

  // Polling update for active chart (unless paused)
  useEffect(() => {
    if (isPaused || !tokenAddr) return;
    const id = setInterval(() => {
      api.history(chain, tokenAddr).then(setHistory).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [tokenAddr, chain, isPaused]);

  const selected = (entries ?? []).find(
    (e) => e.chainId.toLowerCase() === chain.toLowerCase() &&
           e.tokenAddress.toLowerCase() === tokenAddr.toLowerCase(),
  );

  const points =
    history.length > 0
      ? history
      : selected?.market
      ? [{ priceUsd: selected.market.priceUsd, ts: Date.now() }]
      : [];

  const svgW = 800;
  const svgH = 340;
  const pad = { l: 65, r: 24, t: 24, b: 36 };
  const plotW = svgW - pad.l - pad.r;
  const plotH = svgH - pad.t - pad.b;

  const prices = points.map((p) => p.priceUsd);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  // Area path: line + bottom fill
  const linePoints = points.map((p, i) => {
    const x = pad.l + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = pad.t + plotH - ((p.priceUsd - min) / range) * plotH;
    return { x, y };
  });

  const linePath =
    linePoints.length > 1
      ? linePoints.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')
      : '';

  const areaPath =
    linePoints.length > 1
      ? `${linePath} L${linePoints[linePoints.length - 1].x.toFixed(1)},${(pad.t + plotH).toFixed(1)} L${linePoints[0].x.toFixed(1)},${(pad.t + plotH).toFixed(1)} Z`
      : '';

  const lastPt = linePoints[linePoints.length - 1];

  const timeLabels =
    points.length > 1
      ? [points[0], points[points.length - 1]].map((p) =>
          new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        )
      : [];

  const isUp = points.length > 1 ? points[points.length - 1].priceUsd >= points[0].priceUsd : true;
  const strokeColor = isUp ? 'var(--up)' : 'var(--down)';
  const areaGradientId = isUp ? 'areaUp' : 'areaDown';

  return (
    <>
      <div className="page-head">
        <h1>Price Chart</h1>
        <p>Grafik harga realtime dari watchlist.</p>
      </div>

      {/* Quick select chips from watchlist */}
      {entries && entries.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'center' }}>Watchlist:</span>
          {entries.map((e) => {
            const active = e.tokenAddress.toLowerCase() === tokenAddr.toLowerCase();
            return (
              <button
                key={`${e.chainId}:${e.tokenAddress}`}
                className={`btn${active ? ' primary' : ''}`}
                style={{ padding: '6px 12px', minHeight: 36, fontSize: 13 }}
                onClick={() => {
                  setTokenAddr(e.tokenAddress);
                  setChain(e.chainId);
                  loadHistory(e.tokenAddress, e.chainId);
                }}
              >
                {e.symbol ?? e.tokenAddress.slice(0, 4)} ({e.chainId})
              </button>
            );
          })}
        </div>
      )}

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        {/* Input bar */}
        <div className="row" style={{ marginBottom: 16 }}>
          <select
            className="input"
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            style={{ width: 140 }}
            aria-label="Pilih Chain"
          >
            <option value="solana">Solana</option>
            <option value="base">Base</option>
            <option value="ethereum">Ethereum</option>
            <option value="arbitrum">Arbitrum</option>
            <option value="bsc">BSC</option>
          </select>
          <input
            className="input"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="Address token untuk melihat chart"
            value={tokenAddr}
            onChange={(e) => setTokenAddr(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadHistory(tokenAddr, chain)}
            aria-label="Address token"
          />
          <button
            className="btn primary"
            onClick={() => loadHistory(tokenAddr, chain)}
            disabled={loadingHistory || !tokenAddr.trim()}
          >
            {loadingHistory ? 'Loading…' : 'Tampilkan'}
          </button>
          {points.length > 0 && (
            <button
              className="btn"
              onClick={() => setIsPaused((p) => !p)}
              title={isPaused ? 'Lanjutkan auto-update' : 'Pause auto-update'}
              aria-label={isPaused ? 'Resume auto-update' : 'Pause auto-update'}
            >
              {isPaused ? <><IconPlay size={14} /> Resume</> : <><IconPause size={14} /> Pause</>}
            </button>
          )}
        </div>

        {/* Selected token header summary */}
        {selected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-heading)' }}>
              {selected.symbol ?? selected.name ?? 'Token'}
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {fmt.usd(selected.market?.priceUsd ?? (points[points.length - 1]?.priceUsd || 0))}
            </span>
            {selected.market && (
              <span className={`badge ${selected.market.change24h > 0 ? 'up' : 'down'}`}>
                {selected.market.change24h > 0 ? '▲ +' : '▼ '}
                {selected.market.change24h.toFixed(2)}% (24h)
              </span>
            )}
            {isPaused && (
              <span className="chip" style={{ background: 'rgba(245,158,11,.15)', color: 'var(--accent)' }}>
                <IconPause size={12} /> Paused
              </span>
            )}
          </div>
        )}

        {/* Chart SVG */}
        <div className="chart-box">
          {points.length < 2 ? (
            <div className="empty">
              <IconChartLine size={32} />
              {tokenAddr ? 'Mengumpulkan titik harga… Data akan bertambah tiap 15 detik.' : 'Pilih token di atas untuk melihat grafik harga.'}
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              width="100%"
              height="auto"
              style={{ background: 'var(--panel-2)', borderRadius: 10, overflow: 'visible' }}
              onMouseMove={(e) => {
                // Map cursor x (viewBox units) → nearest data index.
                const rect = e.currentTarget.getBoundingClientRect();
                const vx = ((e.clientX - rect.left) / rect.width) * svgW;
                const t = (vx - pad.l) / plotW;
                const idx = Math.round(t * (points.length - 1));
                setHoverIdx(Math.min(points.length - 1, Math.max(0, idx)));
              }}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id="areaUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22C55E" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#22C55E" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="areaDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#EF4444" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#EF4444" stopOpacity="0.0" />
                </linearGradient>
                <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
                </filter>
              </defs>

              {/* Grid lines */}
              <line x1={pad.l} y1={pad.t} x2={pad.l + plotW} y2={pad.t} stroke="var(--border)" strokeDasharray="3 3" opacity="0.5" />
              <line x1={pad.l} y1={pad.t + plotH / 2} x2={pad.l + plotW} y2={pad.t + plotH / 2} stroke="var(--border)" strokeDasharray="3 3" opacity="0.5" />
              <line x1={pad.l} y1={pad.t + plotH} x2={pad.l + plotW} y2={pad.t + plotH} stroke="var(--border)" />
              <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="var(--border)" />

              {/* Area gradient fill */}
              {areaPath && <path d={areaPath} fill={`url(#${areaGradientId})`} />}

              {/* Main price line */}
              {linePath && (
                <path
                  d={linePath}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Glowing current-price pulse dot (skill recommendation) */}
              {lastPt && (
                <>
                  <circle
                    cx={lastPt.x}
                    cy={lastPt.y}
                    r={8}
                    fill={strokeColor}
                    opacity={0.3}
                    filter="url(#glow)"
                  />
                  <circle cx={lastPt.x} cy={lastPt.y} r={4.5} fill={strokeColor} />
                </>
              )}

              {/* Time axis */}
              {timeLabels.length === 2 && (
                <>
                  <text x={pad.l} y={svgH - 10} fill="var(--muted)" fontSize={11} fontFamily="var(--font-body)">
                    {timeLabels[0]}
                  </text>
                  <text x={svgW - pad.r} y={svgH - 10} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">
                    {timeLabels[1]}
                  </text>
                </>
              )}

              {/* Price axis (Max, Mid, Min) */}
              <text x={pad.l - 8} y={pad.t + 4} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">
                {fmt.usd(max)}
              </text>
              <text x={pad.l - 8} y={pad.t + plotH / 2 + 4} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">
                {fmt.usd((max + min) / 2)}
              </text>
              <text x={pad.l - 8} y={pad.t + plotH + 4} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">
                {fmt.usd(min)}
              </text>

              {/* Hover crosshair + tooltip */}
              {hoverIdx !== null && hoverIdx < points.length && linePoints[hoverIdx] && (
                <>
                  <line
                    x1={linePoints[hoverIdx].x}
                    y1={pad.t}
                    x2={linePoints[hoverIdx].x}
                    y2={pad.t + plotH}
                    stroke="var(--muted)"
                    strokeDasharray="4 4"
                    opacity={0.6}
                  />
                  <circle cx={linePoints[hoverIdx].x} cy={linePoints[hoverIdx].y} r={5} fill={strokeColor} stroke="var(--bg)" strokeWidth={2} />
                  <g transform={`translate(${Math.min(linePoints[hoverIdx].x + 10, svgW - pad.r - 130)}, ${Math.max(linePoints[hoverIdx].y - 34, pad.t + 4)})`}>
                    <rect width={128} height={30} rx={6} fill="var(--panel)" stroke="var(--border)" opacity={0.96} />
                    <text x={8} y={13} fill="var(--text)" fontSize={11} fontWeight={700} fontFamily="var(--font-body)">
                      ${points[hoverIdx].priceUsd.toFixed(6)}
                    </text>
                    <text x={8} y={25} fill="var(--muted)" fontSize={10} fontFamily="var(--font-body)">
                      {new Date(points[hoverIdx].ts).toLocaleTimeString()}
                    </text>
                  </g>
                </>
              )}
            </svg>
          )}
        </div>
      </div>

      {/* Recent price points table */}
      <div className="card">
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>
          Riwayat Titik Harga ({points.length} titik)
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Waktu</th>
                <th className="num">Harga (USD)</th>
              </tr>
            </thead>
            <tbody>
              {points.slice(-15).reverse().map((p) => (
                <tr key={p.ts}>
                  <td>{new Date(p.ts).toLocaleTimeString()}</td>
                  <td className="num" style={{ fontFamily: 'var(--font-heading)' }}>
                    {fmt.usd(p.priceUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!points.length && <div className="empty">Belum ada titik harga.</div>}
      </div>
    </>
  );
}