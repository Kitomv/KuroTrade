// Memory Inspector — the agents' closed-decision log and skipped signals.
//
// Extracted from Agents.tsx. Presentational: it takes the autopilot config and
// renders what the engine learned, so the page no longer carries 100 lines of
// table markup inside an already-large component.
import { AutopilotConfig } from '../api/client';

/** A signal badge: BUY reads as up, SELL as down, anything else flat. */
function SignalBadge({ signal }: { signal: string }) {
  const cls = signal.includes('BUY') ? 'up' : signal === 'SELL' ? 'down' : 'flat';
  return <span className={`badge ${cls}`}>{signal.replace('_', ' ')}</span>;
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function MemoryInspector({ ap }: { ap: AutopilotConfig }) {
  const decisions = ap.memory ?? [];
  const nearMisses = ap.nearMisses ?? [];
  const acc = ap.signalAccuracy;

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <strong style={{ fontSize: 14 }}>🧠 Memory Inspector</strong>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Keputusan: {decisions.length} · Near-misses: {nearMisses.length}
        </span>
      </div>

      {/* Calibration strip from signalAccuracy */}
      {acc && (acc.acc1h !== null || acc.acc24h !== null) && (
        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong>Kalibrasi sinyal (1h):</strong> {acc.acc1h !== null ? `${acc.acc1h}% (${acc.win1h}/${acc.n1h})` : '—'}
          {' | '}
          <strong>24h:</strong> {acc.acc24h !== null ? `${acc.acc24h}% (${acc.win24h}/${acc.n24h})` : '—'}
          {acc.bySignal && Object.keys(acc.bySignal).length > 0 && (
            <span style={{ marginLeft: 10 }}>
              Per sinyal: {Object.entries(acc.bySignal).map(([k, v]) => `${k.replace('_', ' ')} ${Math.round((v.win1h / v.n1h) * 100)}% (n=${v.n1h})`).join('; ')}
            </span>
          )}
        </div>
      )}

      {decisions.length > 0 && (
        <>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>
            Keputusan tertutup (terbaru dulu)
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Token</th>
                  <th>Sinyal</th>
                  <th className="num">Entry</th>
                  <th className="num">Outcome</th>
                  <th>Regime</th>
                  <th>Exit</th>
                  <th className="num">Hold</th>
                </tr>
              </thead>
              <tbody>
                {decisions.slice(0, 20).map((m, i) => (
                  <tr key={`${m.ts}:${i}`}>
                    <td>{fmtTime(m.ts)}</td>
                    <td><strong>{m.symbol}</strong></td>
                    <td><SignalBadge signal={m.signal} /></td>
                    <td className="num">${m.entryPrice.toFixed(6)}</td>
                    <td className="num"><span className={`badge ${m.outcomePct >= 0 ? 'up' : 'down'}`}>{m.outcomePct >= 0 ? '+' : ''}{m.outcomePct.toFixed(1)}%</span></td>
                    <td><span className="chip" style={{ fontSize: 10 }}>{m.regime ?? '—'}</span></td>
                    <td><span className="chip" style={{ fontSize: 10 }}>{m.exitReason ?? '—'}</span></td>
                    <td className="num">{m.holdMs ? `${Math.round(m.holdMs / 3_600_000)}h` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {nearMisses.length > 0 && (
        <>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>
            Near-misses (sinyal kuat tapi tak dieksekusi)
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Token</th>
                  <th>Sinyal</th>
                  <th className="num">Conf</th>
                  <th className="num">Entry</th>
                  <th>Alasan Skip</th>
                </tr>
              </thead>
              <tbody>
                {nearMisses.slice(0, 20).map((m, i) => (
                  <tr key={`${m.ts}:${i}`}>
                    <td>{fmtTime(m.ts)}</td>
                    <td><strong>{m.symbol}</strong></td>
                    <td><SignalBadge signal={m.signal} /></td>
                    <td className="num">{m.confidence}%</td>
                    <td className="num">${m.entryPrice.toFixed(6)}</td>
                    <td><span className="chip" style={{ fontSize: 10 }}>{m.reason}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {decisions.length === 0 && nearMisses.length === 0 && (
        <div className="empty" style={{ padding: 24 }}>Belum ada memori — nyalakan Auto-Pilot dan biarkan melindungi / mencari posisi.</div>
      )}
    </div>
  );
}
