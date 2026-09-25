// Hot Wallet portfolio — shows the SERVER-SIDE hot wallet's on-chain holdings
// (not Phantom's), used when hot-wallet mode is the active real wallet.
// Balances come from the backend (hotWallet.js getHotWalletPortfolio), so the
// page reflects the wallet that autopilot actually trades, even headless.
// Importers/callers: Portfolio.tsx (replaces RealWalletPortfolio when hot active).
import { useCallback, useEffect, useState } from 'react';
import { api, Position } from '../api/client';
import { useHotWallet } from './HotWalletContext';
import { IconAlert, IconKey, IconCopy, IconArrowDown, IconCheck, IconTrendingUp, IconTrendingDown } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './ToastProvider';
import { shortAddr } from '../lib/solana';

interface Holding {
  mint: string;
  symbol: string;
  name: string | null;
  uiAmount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

interface Snapshot {
  exists: boolean;
  address: string;
  solHeld: number;
  tokenCount: number;
  tokens: Holding[];
  /** Server-computed SOL + SPL value in USD. Authoritative — do not re-derive
   *  the SOL leg client-side (the markets list does not always contain SOL). */
  totalUsd: number | null;
}

/** Copy to clipboard with an insecure-origin fallback (mirrors HotWalletPanel). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

export function HotWalletPortfolio() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [sellingId, setSellingId] = useState<string | null>(null);
  const confirmAction = useConfirm();
  const toast = useToast();
  const { refresh: refreshHotWallet } = useHotWallet();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, ov] = await Promise.all([
        api.hotWalletPortfolio(),
        api.portfolio().catch(() => ({ positions: [] as Position[] })),
        // SOL/USD for valuing the gas balance in the total.
        api.overview().catch(() => null),
      ]);
      setSnap(s);
      setPositions(p.positions ?? []);
      const solMarket = ov?.markets?.find((m) => m.tokenAddress === 'So11111111111111111111111111111111111111112');
      setSolUsd(solMarket?.priceUsd ?? null);
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal memuat portofolio hot wallet');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load only — no auto-refresh (user refreshes manually via button).
  useEffect(() => { load(); }, [load]);

  const handleCopy = async () => {
    if (!snap?.address) return;
    const ok = await copyText(snap.address);
    toast.showToast(ok ? 'Alamat hot wallet disalin' : 'Gagal menyalin — salin manual dari teks di atas', ok ? 'success' : 'error');
  };

  const handleSell = async (pos: Position) => {
    const cur = Number(pos.currentPrice) || Number(pos.avgBuyPrice);
    const ok = await confirmAction({
      title: `Sell ${pos.symbol} sekarang?`,
      message: `Jual ${Number(pos.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${pos.symbol} @ $${cur.toLocaleString(undefined, { maximumFractionDigits: 8 })} via hot wallet (server-side, langsung broadcast on-chain).`,
      confirmLabel: 'Sell sekarang',
      danger: true,
    });
    if (!ok) return;
    setSellingId(pos.tokenAddress);
    setErr('');
    try {
      const r = await api.hotWalletSellPosition(pos.tokenAddress);
      toast.showToast(`Sell ${pos.symbol} OK — ${r.signature.slice(0, 8)}…`, 'success');
      await load();
      refreshHotWallet().catch(() => {});
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal menjual posisi');
    } finally {
      setSellingId(null);
    }
  };

  const handleWithdrawAll = async () => {
    const ok = await confirmAction({
      title: 'Tarik SEMUA SOL ke Phantom?',
      message:
        'Server menghitung jumlah maksimum yang bisa ditarik (saldo − rent − fee), lalu mengirim ke wallet Phantom yang di-bind. ' +
        'Autopilot tidak bisa trading sampai hot wallet diisi ulang. Token SPL tetap tinggal di hot wallet.',
      confirmLabel: 'Ya, tarik semua',
      danger: true,
    });
    if (!ok) return;
    setWithdrawing(true);
    setErr('');
    try {
      const r = await api.hotWalletWithdrawAll();
      toast.showToast(`Tarik berhasil — ${(r.lamports / 1e9).toFixed(6)} SOL terkirim`, 'success');
      await load();
      refreshHotWallet().catch(() => {});
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal menarik saldo');
    } finally {
      setWithdrawing(false);
    }
  };

  if (!snap) {
    return (
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="empty" style={{ padding: 24 }}>
          <IconKey size={28} /> Belum ada hot wallet — buat di panel Hot Wallet (Settings) agar portofolio autopilot muncul di sini.
        </div>
      </div>
    );
  }

  // ---- Derived totals -------------------------------------------------------
  // `snap.totalUsd` is server-computed (SOL + SPL) and authoritative.
  // Fallback to client re-derivation only if absent (older saves / hot path).
  const pricedUsd = snap.tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
  const solValueUsd = solUsd && solUsd > 0 ? snap.solHeld * solUsd : null;
  const totalUsd = snap.totalUsd ?? (solValueUsd !== null ? solValueUsd + pricedUsd : null);

  const costBasis = positions.reduce((s, p) => s + (Number(p.totalCost) || 0), 0);
  const posValue = positions.reduce((s, p) => {
    const cur = Number(p.currentPrice) || Number(p.avgBuyPrice) || 0;
    return s + Number(p.amount) * cur;
  }, 0);
  const unrealizedUsd = posValue - costBasis;
  const unrealizedPct = costBasis > 0 ? (unrealizedUsd / costBasis) * 100 : 0;
  const upTotal = unrealizedUsd >= 0;

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      {/* Header: identity + actions */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>Hot Wallet On-Chain</strong>
          <span className="chip" style={{ background: 'var(--down-bg)', color: 'var(--down)', fontSize: 10, fontWeight: 700, border: '1px solid rgba(239,68,68,.4)' }}>
            HOT WALLET · AUTOPILOT
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" style={{ fontSize: 12, minHeight: 32 }} onClick={handleCopy} title="Copy alamat hot wallet">
            <IconCopy size={13} /> Alamat
          </button>
          <button type="button" className="btn" style={{ fontSize: 12, minHeight: 32 }} onClick={load} disabled={loading}>
            {loading ? <><span className="spinner" aria-hidden /> Memuat…</> : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn"
            style={{ fontSize: 12, minHeight: 32, color: 'var(--accent)', borderColor: 'rgba(245,158,11,.4)' }}
            onClick={handleWithdrawAll}
            disabled={withdrawing || snap.solHeld <= 0.005}
            title="Tarik semua SOL kembali ke Phantom yang di-bind"
          >
            <IconArrowDown size={13} /> {withdrawing ? <><span className="spinner" aria-hidden /> Menarik…</> : 'Tarik SOL'}
          </button>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {err && <div className="error" style={{ marginBottom: 14 }}><IconAlert size={13} /> {err}</div>}

        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12, wordBreak: 'break-all' }}>
          <span style={{ fontFamily: 'var(--font-heading)' }}>{snap.address}</span>
          <span style={{ marginLeft: 8, opacity: .75 }}>· ditradingkan autopilot secara server-side</span>
        </div>

        {/* Top-line KPIs: total value + unrealized PnL + gas */}
        <div className="kpi-grid">
          <div className="card kpi">
            <div className="kpi-label">Total Nilai Hot Wallet</div>
            <div className="kpi-value">{totalUsd === null ? '—' : `$${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</div>
            <div className="kpi-sub">
              {totalUsd === null
                ? 'harga belum tersedia — klik Refresh'
                : `${snap.solHeld.toFixed(4)} SOL + ${snap.tokenCount} token`}
            </div>
          </div>
          <div className="card kpi">
            <div className="kpi-label">Unrealized PnL</div>
            <div className="kpi-value" style={{ color: upTotal ? 'var(--up)' : 'var(--down)' }}>
              {positions.length === 0 ? '—' : `${upTotal ? '+' : ''}$${unrealizedUsd.toFixed(2)}`}
            </div>
            <div className="kpi-sub">
              {positions.length === 0 ? 'belum ada posisi' : `${upTotal ? '+' : ''}${unrealizedPct.toFixed(2)}% · cost $${costBasis.toFixed(2)}`}
            </div>
          </div>
          <div className="card kpi">
            <div className="kpi-label">SOL (gas + fee)</div>
            <div className="kpi-value">{snap.solHeld.toFixed(4)}</div>
            <div className="kpi-sub">{snap.solHeld < 0.005 ? '⚠ di bawah fee reserve — isi ulang' : 'siap untuk transaksi'}</div>
          </div>
          <div className="card kpi">
            <div className="kpi-label">Token On-Chain</div>
            <div className="kpi-value">{snap.tokenCount}</div>
            <div className="kpi-sub">{positions.length} dilacak guardian</div>
          </div>
        </div>

        {/* Active positions — REAL holdings with entry/current/PnL */}
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>Posisi Aktif ({positions.length})</strong>
            {positions.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Nilai posisi <strong style={{ color: 'var(--text)' }}>${posValue.toFixed(2)}</strong>
              </span>
            )}
          </div>
          {positions.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th className="num">Jumlah</th>
                    <th className="num">Entry</th>
                    <th className="num">Harga</th>
                    <th className="num">PnL</th>
                    <th className="num">Nilai</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos) => {
                    const cur = Number(pos.currentPrice) || Number(pos.avgBuyPrice);
                    const entry = Number(pos.avgBuyPrice) || 0;
                    const pnlPct = entry > 0 && cur > 0 ? ((cur - entry) / entry) * 100 : 0;
                    const pnlUsd = entry > 0 && cur > 0 ? (cur - entry) * Number(pos.amount) : 0;
                    const up = pnlPct >= 0;
                    const value = Number(pos.amount) * cur;
                    return (
                      <tr key={pos.tokenAddress}>
                        <td>
                          <div className="tok">
                            <div className="ph" style={{ width: 28, height: 28, fontSize: 11 }}>
                              {(pos.symbol ?? '?').slice(0, 2).toUpperCase()}
                            </div>
                            <div className="meta">
                              <div className="sym">{pos.symbol}</div>
                              {pos.tp1Hit && <div className="chip" style={{ fontSize: 9 }}>moonbag (TP1 hit)</div>}
                            </div>
                          </div>
                        </td>
                        <td className="num">{Number(pos.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                        <td className="num">${entry.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                        <td className="num">${cur.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                        <td className="num" style={{ color: up ? 'var(--up)' : 'var(--down)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {up ? <IconTrendingUp size={12} /> : <IconTrendingDown size={12} />}
                          {up ? '+' : ''}{pnlPct.toFixed(2)}%
                          <div style={{ fontSize: 11, opacity: .85 }}>({up ? '+' : '-'}${Math.abs(pnlUsd).toFixed(2)})</div>
                        </td>
                        <td className="num">${value.toFixed(2)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {sellingId === pos.tokenAddress ? (
                            <span style={{ color: 'var(--accent)', fontSize: 11 }}>Menjual…</span>
                          ) : (
                            <button
                              type="button"
                              className="btn"
                              style={{ fontSize: 11, minHeight: 28, padding: '2px 8px' }}
                              disabled={sellingId !== null}
                              onClick={() => handleSell(pos)}
                            >
                              Sell
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty" style={{ marginTop: 10, padding: 18 }}>
              Belum ada posisi aktif — autopilot akan membuka posisi pertama setelah menyala.
            </div>
          )}
        </div>

        {/* Raw on-chain holdings (includes tokens the guardian does not track) */}
        {snap.tokenCount > 0 && (
          <div style={{ marginTop: 20 }}>
            <strong style={{ fontSize: 13 }}>Semua Holding On-Chain ({snap.tokenCount})</strong>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Mint</th>
                    <th className="num">Jumlah</th>
                    <th className="num">Harga</th>
                    <th className="num">Nilai</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.tokens.map((t) => (
                    <tr key={t.mint}>
                      <td>
                        <strong>{t.symbol}</strong>
                        {t.name && <div className="nm" style={{ fontSize: 11 }}>{t.name}</div>}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--muted)' }}>{shortAddr(t.mint, 4)}</td>
                      <td className="num">{t.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td className="num">{t.priceUsd ? `$${t.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 8 })}` : '—'}</td>
                      <td className="num">{t.valueUsd ? `$${t.valueUsd.toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {!loading && snap.tokenCount === 0 && (
          <div className="empty" style={{ marginTop: 12 }}>
            Belum ada SPL token — autopilot akan membeli token pertama setelah menyala.
          </div>
        )}
      </div>
    </div>
  );
}