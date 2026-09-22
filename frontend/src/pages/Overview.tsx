import { useState } from 'react';
import { api, Market } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { KpiCard } from '../components/KpiCard';
import { IconBot, IconBolt, IconChartBar, IconDroplet, IconFire, IconGem, IconLayout, IconRocket, IconStar } from '../components/Icons';
import { fmt } from '../lib/format';
import { useToast } from '../components/ToastProvider';
import { StaleBadge } from '../components/StaleBadge';
import { useRealWallet } from '../components/RealWalletContext';

interface Props {
  refreshWatchlist: () => void;
  onNavigateTab?: (page: 'trade' | 'chart' | 'watchlist' | 'agents', market?: Market) => void;
}

export function Overview({ refreshWatchlist, onNavigateTab }: Props) {
  const [activeTab, setActiveTab] = useState<'trending' | 'gainers' | 'losers' | 'liquidity'>('trending');
  const [selectedChain, setSelectedChain] = useState<string>('all');
  const toast = useToast();

  const overview = usePolling(() => api.overview(), 10_000, []);
  const aiSignalsP = usePolling(() => api.agentSignals(3), 20_000, []);
  const data = overview.data;
  const aiSignals = aiSignalsP.data;

  const { realMode, connected, isBound } = useRealWallet();

  const handlePin = async (m: Market) => {
    try {
      await api.addWatch({
        tokenAddress: m.tokenAddress,
        chainId: m.chainId,
        symbol: m.symbol,
        name: m.name,
        icon: m.icon,
      });
      refreshWatchlist();
      toast.showToast(`${m.symbol} berhasil ditambahkan ke Watchlist!`, 'success');
    } catch {
      toast.showToast(`Gagal menambahkan ${m.symbol}`, 'error');
    }
  };

  if (!data) {
    return (
      <>
        <div className="page-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span className="dot" style={{ width: 10, height: 10, background: 'var(--accent)' }} />
            <h1>DeFi Market Overview</h1>
          </div>
          <p>Memuat telemetri pasar on-chain DexScreener realtime…</p>
        </div>
        <div className="kpi-grid">
          <div className="card kpi skeleton-row" />
          <div className="card kpi skeleton-row" />
          <div className="card kpi skeleton-row" />
          <div className="card kpi skeleton-row" />
        </div>
      </>
    );
  }

  const allMarkets: Market[] = data.markets ?? [];
  const gainer = data.topGainer;
  const loser = data.topLoser;
  const walletSnap = data.walletSnapshot ?? { balance: 100, totalValue: 100, openPositionsCount: 0 };

  // Filter by chain
  const chainFiltered = selectedChain === 'all'
    ? allMarkets
    : allMarkets.filter((m) => m.chainId.toLowerCase() === selectedChain.toLowerCase());

  // Tab sorting
  const displayMarkets = [...chainFiltered].sort((a, b) => {
    if (activeTab === 'gainers') return (Number(b.change24h) || 0) - (Number(a.change24h) || 0);
    if (activeTab === 'losers') return (Number(a.change24h) || 0) - (Number(b.change24h) || 0);
    if (activeTab === 'liquidity') return (Number(b.liquidityUsd) || 0) - (Number(a.liquidityUsd) || 0);
    // Trending: sort by volume turnover
    return (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0);
  });

  const topAi = aiSignals && aiSignals.length > 0 ? aiSignals[0] : null;

  return (
    <>
      {/* Top Header with Live Beacon */}
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span className="dot" style={{ width: 10, height: 10, background: '#22c55e', boxShadow: '0 0 14px #22c55e' }} />
            <h1>DeFi Market Intelligence</h1>
            <span className="chip" style={{ background: 'rgba(34, 197, 94, .12)', color: 'var(--up)', fontSize: 11, fontWeight: 700, boxShadow: '0 0 12px rgba(34,197,94,.25)' }}>
              DEXSCREENER LIVE
            </span>
            <StaleBadge stale={overview.stale || aiSignalsP.stale} />
          </div>
          <p>Radar pasar terdesentralisasi multi-chain — update otomatis setiap 10 detik.</p>
        </div>

        {/* Chain selector pills */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {['all', 'solana', 'base', 'ethereum', 'bsc', 'arbitrum'].map((c) => (
            <button
              key={c}
              className={`chip${selectedChain === c ? ' active' : ''}`}
              style={{
                cursor: 'pointer',
                background: selectedChain === c ? 'rgba(245, 158, 11, .2)' : 'var(--panel-2)',
                color: selectedChain === c ? 'var(--accent)' : 'var(--muted)',
                borderColor: selectedChain === c ? 'rgba(245, 158, 11, .4)' : 'transparent',
                border: '1px solid',
                textTransform: 'uppercase',
                padding: '6px 12px',
                fontSize: 11,
              }}
              onClick={() => setSelectedChain(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 4 Upgraded KPI Metric Cards */}
      <div className="kpi-grid">
        <KpiCard
          label="Volume 24h Terpantau"
          value={fmt.usd(data.totalVolume24h)}
          sub={`$${((data.totalLiquidityUsd ?? 0) / 1000000).toFixed(2)}M Likuiditas Pool`}
        />
        <KpiCard
          label="Top Gainer 24h"
          value={gainer?.symbol ?? '—'}
          sub={gainer ? `${fmt.pct(gainer.change24h)} · ${fmt.usd(gainer.volume24h)} vol` : ''}
          variant={gainer?.change24h ? (gainer.change24h > 0 ? 'up' : 'down') : undefined}
        />
        <KpiCard
          label="Dip / Volatilitas Tertinggi"
          value={loser?.symbol ?? '—'}
          sub={loser ? `${fmt.pct(loser.change24h)} 24h · Peluang Reversal` : ''}
          variant={loser?.change24h ? (loser.change24h > 0 ? 'up' : 'down') : undefined}
        />
        {realMode ? (
          <KpiCard
            label="Real Wallet"
            value={!connected ? 'Phantom?' : !isBound ? 'Perlu Bind' : 'AKTIF'}
            sub={!connected ? 'Connect untuk mode real' : !isBound ? 'Bind wallet di panel Real Wallet' : 'Dana asli — eksekusi via Phantom'}
            variant={connected && isBound ? 'up' : undefined}
          />
        ) : (
          <KpiCard
            label="Virtual Portfolio"
            value={`$${walletSnap.balance.toFixed(2)}`}
            sub={`${walletSnap.openPositionsCount} posisi aktif · Total $${walletSnap.totalValue.toFixed(2)}`}
          />
        )}
      </div>

      {/* AI Radar Signal Callout Banner (if available) */}
      {topAi && (
        <div
          className="card"
          style={{
            padding: '16px 20px',
            marginBottom: 24,
            background: 'linear-gradient(90deg, rgba(245,158,11,.12) 0%, rgba(139,92,246,.12) 100%)',
            border: '1px solid rgba(245,158,11,.3)',
            boxShadow: '0 0 18px rgba(245,158,11,.12)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <IconBot size={26} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 15, fontFamily: 'var(--font-heading)' }}>
                  AI Radar Sinyal Teratas: {topAi.token.symbol}
                </strong>
                <span className={`badge ${topAi.verdict.signal.includes('BUY') ? 'up' : 'down'}`}>
                  {topAi.verdict.signal.replace('_', ' ')} ({topAi.verdict.confidence}%)
                </span>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 2 }}>
                {topAi.verdict.summary}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn primary"
              style={{ padding: '8px 16px', fontSize: 13 }}
              onClick={() => onNavigateTab && onNavigateTab('agents')}
            >
              Lihat Debat AI →
            </button>
          </div>
        </div>
      )}

      {/* Main Market Movers Table Section with Interactive Tabs */}
      <div className="card" style={{ marginBottom: 24 }}>
        {/* Table Header & Tabs */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          {/* Navigation Tabs */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn${activeTab === 'trending' ? ' primary' : ''}`}
              style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}
              onClick={() => setActiveTab('trending')}
            >
              <IconFire size={14} /> Trending Volume
            </button>
            <button
              className={`btn${activeTab === 'gainers' ? ' primary' : ''}`}
              style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}
              onClick={() => setActiveTab('gainers')}
            >
              <IconRocket size={14} /> Top Gainers
            </button>
            <button
              className={`btn${activeTab === 'losers' ? ' primary' : ''}`}
              style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}
              onClick={() => setActiveTab('losers')}
            >
              <IconDroplet size={14} /> Top Dips
            </button>
            <button
              className={`btn${activeTab === 'liquidity' ? ' primary' : ''}`}
              style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}
              onClick={() => setActiveTab('liquidity')}
            >
              <IconGem size={14} /> High Liquidity
            </button>
          </div>

          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Menampilkan {displayMarkets.length} pool terverifikasi
          </span>
        </div>

        {/* Table Content */}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token & Pool</th>
                <th className="num">Harga (USD)</th>
                <th className="num">Trend 5m</th>
                <th className="num">Trend 1h</th>
                <th className="num">Perubahan 24h</th>
                <th>Mini Trend (24h)</th>
                <th className="num">Volume 24h</th>
                <th className="num">Likuiditas</th>
                <th style={{ textAlign: 'right' }}>Aksi Cepat</th>
              </tr>
            </thead>
            <tbody>
              {displayMarkets.map((m) => {
                const c5m = Number(m.change5m) || 0;
                const c1h = Number(m.change1h) || 0;
                const c24h = Number(m.change24h) || 0;

                return (
                  <tr key={m.pairAddress || m.tokenAddress}>
                    <td>
                      <div className="tok">
                        {m.icon ? (
                          <img src={m.icon} alt={`${m.symbol} icon`} />
                        ) : (
                          <div className="ph">{(m.symbol ?? '?').slice(0, 2).toUpperCase()}</div>
                        )}
                        <div className="meta">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="sym">{m.symbol ?? 'UNKNOWN'}</span>
                            <span className="chip" style={{ fontSize: 10, padding: '1px 6px' }}>{m.chainId}</span>
                          </div>
                          {m.name && <div className="nm">{m.name}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 600 }}>
                      {fmt.usd(m.priceUsd)}
                    </td>
                    <td className="num">
                      <TimeframeBadge pct={c5m} />
                    </td>
                    <td className="num">
                      <TimeframeBadge pct={c1h} />
                    </td>
                    <td className="num">
                      <ChangeBadge pct={c24h} />
                    </td>
                    <td>
                      <Sparkline points={[c5m, c1h, c24h]} isUp={c24h >= 0} />
                    </td>
                    <td className="num">{fmt.usd(m.volume24h)}</td>
                    <td className="num">{fmt.usd(m.liquidityUsd)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          className="btn icon"
                          style={{ padding: '6px 10px', minHeight: 32, fontSize: 12 }}
                          title="Pin ke Watchlist"
                          aria-label={`Pin ${m.symbol ?? 'token'} ke Watchlist`}
                          onClick={() => handlePin(m)}
                        >
                          <IconStar size={13} />
                        </button>
                        {onNavigateTab && (
                          <button
                            className="btn primary icon"
                            style={{ padding: '6px 10px', minHeight: 32, fontSize: 12, fontWeight: 700 }}
                            title="Trading token ini"
                            aria-label={`Trade ${m.symbol ?? 'token'}`}
                            onClick={() => onNavigateTab('trade', m)}
                          >
                            <IconBolt size={13} /> Trade
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!displayMarkets.length && (
          <div className="empty" style={{ padding: 36 }}>
            <IconLayout size={32} />
            Tidak ada data pasar untuk filter jaringan "{selectedChain}".
          </div>
        )}
      </div>
    </>
  );
}

function Sparkline({ points, isUp }: { points: number[]; isUp: boolean }) {
  const w = 70;
  const h = 22;
  const color = isUp ? '#22c55e' : '#ef4444';

  const min = Math.min(...points, -1);
  const max = Math.max(...points, 1);
  const range = max - min || 1;

  const pts = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
}

function TimeframeBadge({ pct }: { pct: number }) {
  const isUp = pct > 0;
  const isDown = pct < 0;
  const cls = isUp ? 'up' : isDown ? 'down' : 'flat';
  return (
    <span className={`badge ${cls}`} style={{ fontSize: 11, padding: '2px 7px' }}>
      {isUp ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

function ChangeBadge({ pct }: { pct: number }) {
  const isUp = pct > 0;
  const isDown = pct < 0;
  const cls = isUp ? 'up' : isDown ? 'down' : 'flat';
  const icon = isUp ? '▲' : isDown ? '▼' : '•';
  return (
    <span
      className={`badge ${cls}`}
      aria-label={`24h change ${pct > 0 ? '+' : ''}${pct.toFixed(2)}% (${isUp ? 'naik' : isDown ? 'turun' : 'tetap'})`}
      style={{ fontWeight: 700 }}
    >
      <span style={{ fontSize: '9px' }}>{icon}</span>
      {pct > 0 ? '+' : ''}
      {pct.toFixed(2)}%
    </span>
  );
}
