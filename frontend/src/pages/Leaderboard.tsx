import { api, LeaderboardRow } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { IconStar } from '../components/Icons';
import { fmt } from '../lib/format';
import { StaleBadge } from '../components/StaleBadge';
import { useEvmWallet } from '../components/EvmWalletContext';

export function Leaderboard() {
  const { realMode } = useEvmWallet();
  const p = usePolling(() => api.leaderboard(), 15_000, []);
  const list: LeaderboardRow[] = p.data ?? [];

  return (
    <>
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Leaderboard <StaleBadge stale={p.stale} /></h1>
        <p>Ranking portofolio semua user — nilai per harga terakhir tersimpan (refresh 15s).
          {realMode && <span style={{ color: 'var(--down)' }}> Ranking = portofolio VIRTUAL; wallet real tidak dihitung.</span>}
        </p>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th className="num">Total Portofolio</th>
                <th className="num">PnL %</th>
                <th className="num">Posisi</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.userId}>
                  <td style={{ fontWeight: 700, fontFamily: 'var(--font-heading)' }}>
                    {i === 0 ? <IconStar size={14} /> : i + 1}
                  </td>
                  <td><strong>{r.username}</strong></td>
                  <td className="num">{fmt.usd(r.totalValue)}</td>
                  <td className="num">
                    <span className={`badge ${r.pnlPct >= 0 ? 'up' : 'down'}`}>
                      {r.pnlPct >= 0 ? '+' : ''}{r.pnlPct.toFixed(2)}%
                    </span>
                  </td>
                  <td className="num">{r.positionsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!list.length && <div className="empty"><span className="icon">🏆</span>Belum ada data user.</div>}
      </div>
    </>
  );
}
