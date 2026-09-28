// On-chain wallet detail for the Portfolio page, shown ONLY when real mode is
// on (the virtual ledger is hidden then — real funds are what matters).
// Balances come from the backend, which prices the bound address server-side;
// the swap dialog reuses RealTradeForm rather than reimplementing quote → sign.
// Importers/callers: Portfolio.tsx (when realMode).
// API/data: GET /api/real/portfolio; RealTradeForm for swaps.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from './Modal';
import { RealTradeForm } from './RealTradeForm';
import { useEvmWallet } from './EvmWalletContext';
import { IconAlert, IconLock } from './Icons';
import { shortAddr } from '../lib/evm';

interface Holding {
  token: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

/** Native coin below this cannot pay for an exit swap — the wallet is stuck. */
const GAS_FLOOR = 0.005;

export function RealWalletPortfolio() {
  const { connected, isBound, address, chainId } = useEvmWallet();
  const chain = 'base';

  const [native, setNative] = useState<number | null>(null);
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);

  const load = useCallback(async () => {
    if (!connected || !address || !isBound) {
      setNative(null); setHoldings([]); setTotalUsd(null); setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snap = await api.realPortfolio(chain);
      setNative(snap.native);
      setTotalUsd(snap.totalUsd);
      setHoldings([...snap.holdings].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)));
      setErr('');
    } catch (e: unknown) {
      setErr(String((e as { message?: string })?.message ?? 'Gagal memuat saldo on-chain'));
    } finally {
      setLoading(false);
    }
  }, [connected, address, isBound]);

  useEffect(() => { load(); }, [load]);

  if (!connected) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div className="empty" style={{ padding: 16 }}>
          Connect MetaMask untuk melihat detail wallet on-chain (dana asli).
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>Wallet On-Chain (Dana Asli)</strong>
          <span className="chip" style={{ background: 'var(--down-bg)', color: 'var(--down)', fontSize: 10, fontWeight: 700, border: '1px solid rgba(239,68,68,.4)' }}>
            REAL
          </span>
          {!isBound && (
            <span className="chip" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10.5 }}>
              Belum bind — swap dikunci
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" style={{ fontSize: 12, minHeight: 32 }} onClick={load} disabled={loading}>
            {loading ? 'Memuat…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn primary"
            style={{ fontSize: 12, minHeight: 32 }}
            onClick={() => setSwapOpen(true)}
            disabled={!isBound}
            title={isBound ? 'Buka form swap dana asli' : 'Bind wallet dulu di panel Real Wallet'}
          >
            Swap / Trade
          </button>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {err && <div className="error" style={{ marginBottom: 14 }}><IconAlert size={13} /> {err}</div>}
        {!isBound && (
          <div className="error" style={{ marginBottom: 14, background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'rgba(232, 163, 61, .4)' }}>
            <IconLock size={13} /> Bind wallet dulu (panel Real Wallet di sidebar) sebelum swap dana asli.
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, wordBreak: 'break-all' }}>
          {address ? shortAddr(address, 6) : '—'}
          {chainId && chainId !== '0x2105' && (
            <span style={{ color: 'var(--accent)' }}> · wallet di chain {chainId}, data di bawah untuk Base</span>
          )}
        </div>

        <div className="kpi-grid">
          <div className="card kpi">
            <div className="kpi-label">ETH (gas + trade)</div>
            <div className="kpi-value">{native === null ? '…' : native.toFixed(4)}</div>
            <div className="kpi-sub">
              {native !== null && native < GAS_FLOOR ? '⚠ di bawah biaya gas' : 'siap untuk transaksi'}
            </div>
          </div>
          <div className="card kpi">
            <div className="kpi-label">Total Nilai</div>
            <div className="kpi-value">
              {totalUsd === null ? '…' : `$${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            </div>
            <div className="kpi-sub">{holdings.length} token on-chain</div>
          </div>
        </div>

        {holdings.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Kontrak</th>
                  <th className="num">Jumlah</th>
                  <th className="num">Nilai</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((t) => (
                  <tr key={t.token}>
                    <td><strong>{shortAddr(t.token, 4)}</strong></td>
                    <td style={{ fontSize: 11, color: 'var(--muted)' }}>{shortAddr(t.token, 4)}</td>
                    <td className="num">{t.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                    <td className="num">
                      {t.valueUsd === null ? <span style={{ color: 'var(--muted)' }}>—</span> : `$${t.valueUsd.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && holdings.length === 0 && (
          <div className="empty" style={{ marginTop: 12 }}>
            Belum ada token ERC-20 di wallet ini. Kirim ETH ke alamat di atas untuk mulai trading.
          </div>
        )}
      </div>

      {swapOpen && (
        <Modal title="Swap Dana Asli" onClose={() => { setSwapOpen(false); load(); }} maxWidth={560}>
          <RealTradeForm />
        </Modal>
      )}
    </div>
  );
}
