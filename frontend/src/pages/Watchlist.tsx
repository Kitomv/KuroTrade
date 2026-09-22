import { useState } from 'react';
import { api } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { IconAlert, IconStar, IconX } from '../components/Icons';
import { WatchEntry } from '../api/client';
import { fmt } from '../lib/format';
import { useToast } from '../components/ToastProvider';
import { StaleBadge } from '../components/StaleBadge';

export function Watchlist({ onUpdated }: { onUpdated: () => void }) {
  const [addr, setAddr] = useState('');
  const [chain, setChain] = useState('solana');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const toast = useToast();

  const p = usePolling(
    () => api.watchlist(),
    15_000,
    [],
  );
  const data = p.data;

  const handleAdd = async () => {
    if (!addr.trim()) return;
    setAdding(true);
    setErr('');
    try {
      await api.addWatch({ tokenAddress: addr.trim(), chainId: chain });
      const short = addr.trim().length > 12 ? `${addr.trim().slice(0, 6)}…${addr.trim().slice(-4)}` : addr.trim();
      setAddr('');
      toast.showToast(`${short} ditambahkan ke Watchlist!`, 'success');
      onUpdated();
    } catch (e: any) {
      setErr(e.message ?? 'Gagal menambah token. Pastikan address benar.');
    } finally {
      setAdding(false);
    }
  };

  const copyAddr = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  const entries: WatchEntry[] = data ?? [];

  return (
    <>
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Watchlist <StaleBadge stale={p.stale} /></h1>
        <p>Token yang kamu pantau — update setiap 15 detik.</p>
      </div>

      <div className="card" style={{ marginBottom: 20, padding: 20 }}>
        <div className="row">
          <input
            className="input"
            style={{ flex: 1, minWidth: 260 }}
            placeholder="Token address (0x… atau Solana mint)"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            aria-label="Token address"
          />
          <select
            className="input"
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            style={{ width: 150 }}
            aria-label="Pilih Blockchain"
          >
            <option value="solana">Solana</option>
            <option value="base">Base</option>
            <option value="ethereum">Ethereum</option>
            <option value="arbitrum">Arbitrum</option>
            <option value="bsc">BSC</option>
          </select>
          <button className="btn primary" onClick={handleAdd} disabled={adding || !addr.trim()}>
            {adding ? 'Menambahkan…' : 'Tambah'}
          </button>
        </div>
        {err && (
          <div className="error" style={{ marginTop: 12 }}>
            <IconAlert size={16} />
            <span>{err}</span>
          </div>
        )}
      </div>

      {!data && (
        <div className="card">
          <div style={{ padding: 20 }}>
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
                  <th className="num">Liquidity</th>
                  <th>Chain</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const m = e.market;
                  const key = `${e.chainId}:${e.tokenAddress}`;
                  return (
                    <tr key={key}>
                      <td>
                        <div className="tok">
                          {m?.icon ? (
                            <img src={m.icon} alt="" />
                          ) : (
                            <div className="ph">{(e.symbol ?? '?').slice(0, 2).toUpperCase()}</div>
                          )}
                          <div className="meta">
                            <div className="sym">{e.symbol ?? 'Unknown'}</div>
                            <div
                              className="nm"
                              style={{ cursor: 'pointer', opacity: 0.8 }}
                              title="Klik untuk copy address"
                              aria-label={`Salin address ${e.symbol ?? e.tokenAddress}`}
                              onClick={() => copyAddr(e.tokenAddress)}
                            >
                              {copied === e.tokenAddress ? '✓ Copied' : e.name ?? `${e.tokenAddress.slice(0, 6)}…${e.tokenAddress.slice(-4)}`}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="num">{m ? fmt.usd(m.priceUsd) : '—'}</td>
                      <td className="num">
                        {m ? <ChangeBadge pct={m.change24h} /> : '—'}
                      </td>
                      <td className="num">{m ? fmt.usd(m.volume24h) : '—'}</td>
                      <td className="num">{m ? fmt.usd(m.liquidityUsd) : '—'}</td>
                      <td>
                        <span className="chip">{e.chainId}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn icon"
                          onClick={() => api.removeWatch(key).then(onUpdated)}
                          aria-label={`Hapus ${e.symbol ?? e.tokenAddress} dari watchlist`}
                          style={{ color: 'var(--down)', background: 'rgba(239, 68, 68, .1)' }}
                        >
                          <IconX size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!entries.length && (
            <div className="empty">
              <IconStar size={32} />
              Belum ada token di watchlist. Masukkan address token di atas untuk mulai memantau harga realtime.
            </div>
          )}
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