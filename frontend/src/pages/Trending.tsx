import { useState } from 'react';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { TrendingProfile, Market } from '../api/client';
import { fmt } from '../lib/format';
import { StaleBadge } from '../components/StaleBadge';

export function Trending() {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Market[] | null>(null);
  const p = usePolling(
    () => api.trending(),
    15_000,
    [],
  );
  const data = p.data;

  const handleSearch = async () => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await api.search(q.trim());
      setSearchResults(res);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const profiles: TrendingProfile[] = data ?? [];

  return (
    <>
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Trending Tokens <StaleBadge stale={p.stale} /></h1>
        <p>Profil token yang sedang tren di DexScreener — update setiap 15 detik.</p>
      </div>

      <div className="row" style={{ marginBottom: 20 }}>
        <input
          className="input"
          style={{ flex: 1, maxWidth: 360 }}
          placeholder="Cari token (nama atau symbol)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          aria-label="Cari token"
        />
        <button className="btn primary" onClick={handleSearch} disabled={searching}>
          {searching ? 'Mencari…' : 'Cari'}
        </button>
        {searchResults !== null && (
          <button className="btn" onClick={() => { setSearchResults(null); setQ(''); }}>
            Reset
          </button>
        )}
      </div>

      {/* Search results view */}
      {searchResults !== null && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>
            Hasil pencarian untuk "{q}" ({searchResults.length})
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="num">Harga</th>
                  <th className="num">24h</th>
                  <th className="num">Volume 24h</th>
                  <th>Chain</th>
                  <th>DEX</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((m) => (
                  <tr key={m.pairAddress}>
                    <td>
                      <div className="tok">
                        {m.icon ? <img src={m.icon} alt="" /> : <div className="ph">{(m.symbol ?? '?').slice(0, 2).toUpperCase()}</div>}
                        <div className="meta">
                          <div className="sym">{m.symbol ?? 'Unknown'}</div>
                          {m.name && <div className="nm">{m.name}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="num">{fmt.usd(m.priceUsd)}</td>
                    <td className="num"><ChangeBadge pct={m.change24h} /></td>
                    <td className="num">{fmt.usd(m.volume24h)}</td>
                    <td><span className="chip">{m.chainId}</span></td>
                    <td><span className="chip">{m.dexId}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!searchResults.length && <div className="empty">Token tidak ditemukan.</div>}
        </div>
      )}

      {/* Trending list */}
      {!data && (
        <div className="card">
          <div style={{ padding: 20 }}>
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
          </div>
        </div>
      )}

      {data && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="num">Harga</th>
                  <th className="num">24h</th>
                  <th className="num">Volume 24h</th>
                  <th>Chain</th>
                  <th>DEX</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const m = p.market;
                  return (
                    <tr key={p.tokenAddress}>
                      <td>
                        <div className="tok">
                          {m?.icon ? <img src={m.icon} alt="" /> : <div className="ph">{(p.symbol ?? '?').slice(0, 2).toUpperCase()}</div>}
                          <div className="meta">
                            <div className="sym">{p.symbol ?? 'Unknown'}</div>
                            {p.name && <div className="nm">{p.name}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="num">{m ? fmt.usd(m.priceUsd) : '—'}</td>
                      <td className="num">
                        {m ? <ChangeBadge pct={m.change24h} /> : '—'}
                      </td>
                      <td className="num">{m ? fmt.usd(m.volume24h) : '—'}</td>
                      <td><span className="chip">{p.chainId}</span></td>
                      <td><span className="chip">{m?.dexId ?? '—'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!profiles.length && <div className="empty">Tidak ada token trending saat ini.</div>}
        </div>
      )}
    </>
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
    >
      <span style={{ fontSize: '9px' }}>{icon}</span>
      {pct > 0 ? '+' : ''}
      {pct.toFixed(2)}%
    </span>
  );
}