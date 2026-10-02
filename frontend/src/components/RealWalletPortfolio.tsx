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
import { shortAddr, chainKeyFromId, chainNameFromId, NATIVE_SYMBOL_BY_CHAIN } from '../lib/evm';

interface Holding {
  token: string;
  /** Known symbol (e.g. USDT), or null when the backend does not recognise it. */
  symbol: string | null;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

/** Native coin below this cannot pay for an exit swap — the wallet is stuck. */
const GAS_FLOOR = 0.005;

/**
 * The portfolio table shows USDT ONLY.
 *
 * USDT is the funding currency of this app: it is what the user sends in and
 * what every trade is sized in, so a table of autopilot leftovers answered a
 * question nobody asked. The backend still returns every holding (it needs them
 * for exposure), and this view narrows to the one token the user tracks.
 */
const DISPLAY_SYMBOL = 'USDT';

export function RealWalletPortfolio() {
  const { connected, isBound, address, chainId } = useEvmWallet();
  // Read the chain the wallet is ACTUALLY on, not a hardcoded default. Null
  // when the chain has no backend support — the panel then refuses to load
  // rather than showing Base balances as if they were the wallet's.
  const chain = chainKeyFromId(chainId);
  const nativeSymbol = chain ? (NATIVE_SYMBOL_BY_CHAIN[chain] ?? 'ETH') : 'ETH';
  const chainLabel = chainNameFromId(chainId) ?? chainId ?? 'tidak dikenal';

  const [native, setNative] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);

  const load = useCallback(async () => {
    if (!connected || !address || !isBound || !chain) {
      setNative(null); setHoldings([]); setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snap = await api.realPortfolio(chain);
      setNative(snap.native);
      setHoldings(snap.holdings.filter((h) => h.symbol === DISPLAY_SYMBOL));
      setErr('');
    } catch (e: unknown) {
      setErr(String((e as { message?: string })?.message ?? 'Gagal memuat saldo on-chain'));
    } finally {
      setLoading(false);
    }
  }, [connected, address, isBound, chain]);

  const usdt = holdings[0] ?? null;
  // The backend omits zero-balance tokens, so a missing USDT row means "0
  // USDT", not "unknown" — show 0 instead of an ellipsis that never resolves.
  const usdtAmount = usdt?.amount ?? 0;
  const usdtValue = usdt ? (usdt.valueUsd ?? usdt.amount) : null;

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
          {chainId && !chain && (
            <span style={{ color: 'var(--down)' }}> · chain {chainLabel} belum didukung — saldo tidak dimuat</span>
          )}
        </div>

        {chainId && !chain && isBound && (
          <div className="error" style={{ marginBottom: 14 }}>
            <IconAlert size={13} /> Wallet kamu di {chainLabel}. Chain ini belum didukung backend —
            ganti ke Base di MetaMask untuk melihat saldo dan melakukan swap.
          </div>
        )}

        <div className="kpi-grid">
          <div className="card kpi">
            <div className="kpi-label">{nativeSymbol} (gas + trade)</div>
            <div className="kpi-value">{native === null ? '…' : native.toFixed(4)}</div>
            <div className="kpi-sub">
              {native !== null && native < GAS_FLOOR ? '⚠ di bawah biaya gas' : 'siap untuk transaksi'}
            </div>
          </div>
          <div className="card kpi">
            <div className="kpi-label">USDT</div>
            <div className="kpi-value">
              {loading || !isBound ? '…' : usdtAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            <div className="kpi-sub">
              {usdtValue === null ? 'belum ada USDT di wallet' : `≈ $${usdtValue.toFixed(2)}`}
            </div>
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
                    <td><strong>{t.symbol ?? shortAddr(t.token, 4)}</strong></td>
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

        {!loading && isBound && holdings.length === 0 && (
          <div className="empty" style={{ marginTop: 12 }}>
            Belum ada USDT di wallet ini. Kirim USDT ke alamat di atas — sisakan sedikit {nativeSymbol} untuk biaya gas.
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
