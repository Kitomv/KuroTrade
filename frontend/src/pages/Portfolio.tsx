import { useState } from 'react';
import { api, exportCsv, Wallet, Position, Order } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { KpiCard } from '../components/KpiCard';
import { IconBriefcase, IconClock, IconScroll } from '../components/Icons';
import { fmt } from '../lib/format';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmDialog';
import { StaleBadge } from '../components/StaleBadge';
import { useEvmWallet } from '../components/EvmWalletContext';
import { RealWalletPortfolio } from '../components/RealWalletPortfolio';
import { PendingIntents } from '../components/RealTradePanel';

export interface PortfolioData {
  wallet: Wallet;
  positions: Position[];
  orders: Order[];
  /** Total orders on the server (the array above is only the newest page). */
  ordersTotal?: number;
  ordersHasMore?: boolean;
}

export function Portfolio() {
  const {
    realMode, connected, isBound,
    openIntents, approvingId, approveError, approveIntent, cancelIntent,
  } = useEvmWallet();
  // The summary is the same in both modes — keep polling the virtual ledger so
  // the page never goes blank when real mode is switched on.
  const p = usePolling<PortfolioData | undefined>(() => api.portfolio(), 2_500, []);
  const data = p.data;
  const wallet = data?.wallet;
  const positions = data?.positions;
  const orders = data?.orders;
  const [loadingReset, setLoadingReset] = useState(false);
  const [err, setErr] = useState('');
  const [selling, setSelling] = useState<string | null>(null);
  const [showOpenOrders, setShowOpenOrders] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false);
  const [olderOrders, setOlderOrders] = useState<Order[]>([]);
  // Position table controls. With a dozen open positions the old fixed order
  // (server order) meant finding the biggest loser required reading every row.
  const [posSort, setPosSort] = useState<'value' | 'pnl' | 'symbol'>('value');
  const [posQuery, setPosQuery] = useState('');
  const toast = useToast();
  const confirmAction = useConfirm();

  const handleExport = async (kind: 'orders' | 'positions') => {
    setExporting(kind);
    setErr('');
    try {
      await exportCsv(kind);
      toast.showToast(`${kind}.csv diunduh`, 'success');
    } catch (e: any) {
      setErr(e.message ?? 'Gagal export CSV');
    } finally {
      setExporting(null);
    }
  };

  const handleSell = async (p: Position) => {
    const symbol = (p.symbol ?? 'token').toUpperCase();
    const current = p.currentPrice ?? p.avgBuyPrice;
    const ok = await confirmAction({
      title: `Jual ${symbol}`,
      message: `Jual semua ${p.amount.toFixed(4)} ${symbol} pada harga live $${current.toFixed(4)}?`,
      confirmLabel: 'Jual',
      danger: true,
    });
    if (!ok) return;
    setSelling(p.tokenAddress);
    setErr('');
    try {
      await api.marketOrder({
        side: 'sell',
        tokenAddress: p.tokenAddress,
        chainId: p.chainId,
        symbol: p.symbol,
        name: p.name,
        usdAmount: p.amount * current,
        tokenAmount: p.amount,
      });
      toast.showToast(`Sold ${p.symbol} @ $${current.toFixed(4)}`, 'success');
    } catch (e: any) {
      setErr(e.message ?? 'Gagal menjual posisi');
    } finally {
      setSelling(null);
    }
  };

  const handleCancelOrder = async (id: string) => {
    try {
      await api.cancelOrder(id);
      toast.showToast('Order dibatalkan', 'success');
    } catch (e: any) {
      setErr(e.message ?? 'Gagal membatalkan order');
    }
  };

  const w: Wallet = wallet ?? { balance: 100, available: 100, initialBalance: 100, totalValue: 100, totalPositionValue: 0, unrealizedPnl: 0, realizedPnl: 0, reservedUsd: 0 };

  const myPositions = positions ?? [];
  const allOrders = orders ?? [];
  const filledOrders = allOrders.filter((o) => o.status === 'filled');
  const extraOrders = olderOrders ?? [];
  const displayFilledOrders = [...filledOrders, ...extraOrders.filter((o) => o.status === 'filled')];
  const openOrders = allOrders.filter((o) => o.status === 'open');
  const hasMoreOrders = Boolean(data?.ordersHasMore);

  const loadMoreOrders = async () => {
    if (loadingMoreOrders || !hasMoreOrders) return;
    setLoadingMoreOrders(true);
    try {
      const page = await api.ordersPage(100, allOrders.length + extraOrders.length);
      setOlderOrders((prev) => [...prev, ...page.orders]);
    } catch (e: any) {
      setErr(e.message ?? 'Gagal memuat riwayat lebih lama');
    } finally {
      setLoadingMoreOrders(false);
    }
  };

  // Guard against a zero/negative baseline: a corrupt initialBalance would make
  // this Infinity/NaN and render as "e+46%".
  const totalReturn = w.initialBalance > 0 ? ((w.totalValue - w.initialBalance) / w.initialBalance) * 100 : 0;
  // A tiny baseline (e.g. reset to $1) makes the percentage meaningless —
  // report it as "n/a" instead of showing +99,000%.
  const returnMeaningful = Number.isFinite(totalReturn) && Math.abs(totalReturn) <= 10_000;
  const returnLabel = returnMeaningful ? fmt.pct(totalReturn) : '—';

  // Asset allocation: portfolio value per position
  const totalPosValue = w.totalPositionValue || myPositions.reduce((s, p) => s + p.amount * (p.currentPrice ?? p.avgBuyPrice), 0);
  const allocations = myPositions
    .map((p) => {
      const val = p.amount * (p.currentPrice ?? p.avgBuyPrice);
      const pct = totalPosValue > 0 && Number.isFinite(val) ? (val / totalPosValue) * 100 : 0;
      return { ...p, value: val, pct: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0 };
    })
    .sort((a, b) => b.value - a.value);

  // Sorted + filtered view of the position table. Sorting is client-side over
  // the already-polled payload, so switching it costs no request.
  const displayPositions = (() => {
    const q = posQuery.trim().toLowerCase();
    const filtered = q
      ? myPositions.filter((p) =>
          `${p.symbol ?? ''} ${p.name ?? ''} ${p.tokenAddress}`.toLowerCase().includes(q))
      : myPositions;
    const pnlOf = (p: Position) => {
      const cur = p.currentPrice ?? p.avgBuyPrice;
      return p.amount * cur - p.totalCost;
    };
    const sorted = [...filtered];
    if (posSort === 'value') {
      sorted.sort((a, b) => b.amount * (b.currentPrice ?? b.avgBuyPrice) - a.amount * (a.currentPrice ?? a.avgBuyPrice));
    } else if (posSort === 'pnl') {
      sorted.sort((a, b) => pnlOf(b) - pnlOf(a));
    } else {
      sorted.sort((a, b) => (a.symbol ?? '').localeCompare(b.symbol ?? ''));
    }
    return sorted;
  })();

  // Declared here, not above: it reads `myPositions`/`displayFilledOrders`,
  // which are `const` further down. A handler defined before them captures
  // them in the TDZ and throws ReferenceError the moment it is clicked.
  const handleReset = async () => {
    const input = await confirmAction({
      title: 'Reset Saldo Virtual',
      message: 'Masukkan baseline saldo baru. Semua posisi & order akan dihapus; PnL % berikutnya dihitung dari baseline ini.',
      confirmLabel: 'Lanjut',
      input: { label: 'Saldo awal (USDC)', type: 'number', placeholder: '50', initial: String(w.initialBalance), required: true },
    });
    if (!input) return;
    const amount = parseFloat(String(input));
    if (isNaN(amount) || amount <= 0) { setErr('Jumlah tidak valid'); return; }
    // Spell out exactly what is destroyed — the button label said "Set
    // Baseline", which does not advertise that trade history goes with it.
    const ok = await confirmAction({
      title: 'Hapus Semua Data Trading?',
      message: (
        <>
          Saldo akan diset ke <strong>{fmt.usd(amount)}</strong> dan
          <strong style={{ color: 'var(--down)' }}> tidak bisa dikembalikan</strong>:
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>{myPositions.length} posisi aktif dihapus</li>
            <li>{displayFilledOrders.length} riwayat transaksi dihapus</li>
            <li>Riwayat PnL direset ke nol</li>
          </ul>
        </>
      ),
      confirmLabel: 'Hapus & Reset',
      danger: true,
    });
    if (!ok) return;
    setLoadingReset(true);
    setErr('');
    try {
      await api.resetWallet(amount);
      setOlderOrders([]);
      toast.showToast(`Saldo direset ke ${fmt.usd(amount)}`, 'success');
    } catch (e: any) {
      setErr(e.message ?? 'Gagal reset wallet');
    } finally {
      setLoadingReset(false);
    }
  };

  if (realMode) {
    // REAL mode → the page shows the on-chain wallet (balances + swap dialog),
    // not the virtual paper-trading ledger.
    return (
      <>
        <div className="page-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>Portfolio</h1>
            <span className="chip" style={{ background: 'var(--down-bg)', color: 'var(--down)', fontSize: 11, fontWeight: 700, border: '1px solid rgba(239,68,68,.4)' }}>
              REAL · DANA ASLI
            </span>
          </div>
          <p>Detail wallet on-chain (dana asli). Ganti ke virtual lewat panel Real Wallet di sidebar.</p>
        </div>

        {/* The bound MetaMask address is the only real wallet — there is no
            server-side wallet whose books could disagree with it. */}
        <RealWalletPortfolio />
        <PendingIntents
          intents={openIntents}
          approvingId={approvingId}
          approveError={approveError}
          onApprove={approveIntent}
          onCancel={cancelIntent}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h1>Portfolio</h1>
            <span className="chip" style={{ background: 'var(--up-bg)', color: 'var(--up)', fontSize: 10.5 }}>
              LIVE PnL (2s)
            </span>
            <span className="chip" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10.5 }}>
              VIRTUAL {fmt.usd(w.initialBalance)}
            </span>
            <StaleBadge stale={p.stale} />
          </div>
          <p>Ringkasan posisi, PnL, dan riwayat transaksi — harga live DexScreener tiap 2 detik.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => handleExport('orders')} disabled={exporting === 'orders'} style={{ fontSize: 13 }}>
            {exporting === 'orders' ? 'Mengunduh…' : 'Export Orders CSV'}
          </button>
          <button className="btn" onClick={() => handleExport('positions')} disabled={exporting === 'positions'} style={{ fontSize: 13 }}>
            {exporting === 'positions' ? 'Mengunduh…' : 'Export Posisi CSV'}
          </button>
          <button className="btn" onClick={handleReset} disabled={loadingReset} style={{ background: 'var(--down-bg)', borderColor: 'var(--down)', color: 'var(--down)' }}>
            {loadingReset ? 'Resetting…' : 'Set Baseline (Reset)'}
          </button>
        </div>
      </div>

      {/* First-paint skeleton until wallet loads (avoid showing fake $100) */}
      {wallet === undefined && (
        <div className="kpi-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card kpi skeleton-row" style={{ height: 96 }} />
          ))}
        </div>
      )}

      {/* KPI Cards */}
      {wallet !== undefined && (
        <div className="kpi-grid">
          <KpiCard label="Total Portofolio" value={fmt.usd(w.totalValue)} sub={returnMeaningful ? `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}% dari baseline` : `baseline ${fmt.usd(w.initialBalance)}`} variant={returnMeaningful ? (totalReturn >= 0 ? 'up' : 'down') : undefined} />
          <KpiCard label="Kas Tersedia" value={fmt.usd(w.available)} sub={w.reservedUsd > 0 ? `${fmt.usd(w.reservedUsd)} terkunci di limit order` : `${fmt.usd(w.totalPositionValue)} terdeploy ke ${myPositions.length} posisi`} />
          <KpiCard label="PnL Terbuka" value={fmt.usd(w.totalPositionValue)} sub={`${myPositions.length} token di portfolio`} />
          <KpiCard label="Unrealized PnL (mengambang)" value={fmt.usd(w.unrealizedPnl)} sub={allocations.length > 0 ? `mengambang · ${allocations[0].symbol} ${allocations[0].pct.toFixed(0)}% dari posisi` : 'mengambang · belum ada posisi'} variant={w.unrealizedPnl >= 0 ? 'up' : 'down'} />
          <KpiCard label="Realized PnL (terkunci)" value={fmt.usd(w.realizedPnl)} sub="Hasil jual / TP yang terkunci" variant={w.realizedPnl >= 0 ? 'up' : 'down'} />
          <KpiCard label="Total PnL Persen" value={returnLabel} sub={`vs saldo awal ${fmt.usd(w.initialBalance)}`} variant={returnMeaningful ? (totalReturn >= 0 ? 'up' : 'down') : undefined} />
        </div>
      )}

      {/* Asset Allocation Bar */}
      {allocations.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>Komposisi Portofolio</strong>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{allocations.length} aset</span>
          </div>
          <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)' }}>
            {allocations.map((a, i) => (
              <div
                key={a.tokenAddress}
                style={{
                  width: `${a.pct}%`,
                  background: ['var(--accent)', 'var(--accent2)', '#a8763a', 'var(--up)', 'var(--down)'][i % 5],
                  transition: 'width .5s ease',
                }}
                title={`${a.symbol} ${a.pct.toFixed(1)}%`}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
            {allocations.map((a, i) => (
              <div key={a.tokenAddress} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ width: 9, height: 9, background: ['var(--accent)', 'var(--accent2)', '#a8763a', 'var(--up)', 'var(--down)'][i % 5] }} />
                <strong>{a.symbol}</strong>
                <span style={{ color: 'var(--muted)' }}>{a.pct.toFixed(1)}%</span>
                <span style={{ color: 'var(--muted)' }}>· {fmt.usd(a.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Errors / Toast */}
      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      {/* Open Limit Orders */}
      {openOrders.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div
            style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
            onClick={() => setShowOpenOrders(!showOpenOrders)}
          >
            <span><IconClock size={15} /> Open Limit Orders ({openOrders.length})</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{showOpenOrders ? '▲' : '▼'}</span>
          </div>
          {showOpenOrders && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tipe</th>
                    <th>Token</th>
                    <th className="num">Target Price</th>
                    <th className="num">Jumlah</th>
                    <th className="num">Nilai</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <span className={`badge ${o.side === 'buy' ? 'up' : 'down'}`}>
                          {o.side.toUpperCase()} {o.type.toUpperCase()}
                        </span>
                      </td>
                      <td><strong>{o.symbol ?? '—'}</strong></td>
                      <td className="num">{Number.isFinite(Number(o.targetPrice)) ? `$${Number(o.targetPrice).toFixed(6)}` : '—'}</td>
                      <td className="num">{Number.isFinite(Number(o.amount)) ? Number(o.amount).toFixed(4) : '—'}</td>
                      <td className="num">{Number.isFinite(Number(o.usdAmount)) ? fmt.usd(Number(o.usdAmount)) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn icon" style={{ color: 'var(--down)', background: 'var(--down-bg)' }} onClick={() => handleCancelOrder(o.id)}>
                          Batal
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Posisi Aktif */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            Posisi Aktif ({displayPositions.length}
            {posQuery && displayPositions.length !== myPositions.length ? ` / ${myPositions.length}` : ''})
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input"
              type="search"
              placeholder="cari token…"
              value={posQuery}
              onChange={(e) => setPosQuery(e.target.value)}
              style={{ minHeight: 30, padding: '5px 9px', fontSize: 12, width: 150 }}
              aria-label="Cari posisi"
            />
            {(['value', 'pnl', 'symbol'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPosSort(k)}
                aria-pressed={posSort === k}
                className="chip"
                style={{
                  cursor: 'pointer',
                  background: posSort === k ? 'var(--accent-dim)' : 'var(--panel-2)',
                  color: posSort === k ? 'var(--accent)' : 'var(--muted)',
                  borderColor: posSort === k ? 'var(--accent)' : 'var(--rule)',
                }}
              >
                {k === 'value' ? 'Nilai' : k === 'pnl' ? 'PnL' : 'A-Z'}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">Jumlah</th>
                <th className="num">Avg Beli</th>
                <th className="num">Harga Kini</th>
                <th className="num">Peak / Drawdown</th>
                <th className="num">Nilai</th>
                <th className="num">PnL</th>
                <th className="num">PnL %</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayPositions.map((p) => {
                const current = p.currentPrice ?? p.avgBuyPrice;
                const value = p.amount * current;
                const unrealizedPnl = value - p.totalCost;
                const pnlPct = p.totalCost > 0 ? (unrealizedPnl / p.totalCost) * 100 : 0;
                const isUp = unrealizedPnl >= 0;
                const highest = p.highestPrice ?? Math.max(current, p.avgBuyPrice);
                const drawdown = highest > 0 ? ((current - highest) / highest) * 100 : 0;
                return (
                  <tr key={p.tokenAddress}>
                    <td>
                      <div className="tok">
                        <div className="ph">{(p.symbol ?? '?').slice(0, 2).toUpperCase()}</div>
                        <div className="meta">
                          <div className="sym">{p.symbol ?? 'Unknown'}</div>
                          <div className="nm">{p.name || p.chainId}</div>
                        </div>
                      </div>
                    </td>
                    <td className="num">{p.amount.toFixed(4)}</td>
                    <td className="num">{fmt.usd(p.avgBuyPrice)}</td>
                    <td className="num">{fmt.usd(current)}</td>
                    {/* Peak and drawdown answer one question ("how far off the
                        high are we?"), so they share a cell instead of two. */}
                    <td className="num">
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{fmt.usd(highest)}</div>
                      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: drawdown < -5 ? 'var(--down)' : 'var(--dim)' }}>
                        {drawdown.toFixed(1)}%
                      </div>
                    </td>
                    <td className="num">{fmt.usd(value)}</td>
                    <td className="num">
                      <span className={`badge ${isUp ? 'up' : 'down'}`} style={{ fontWeight: 600 }}>
                        {isUp ? '+' : ''}{fmt.usd(unrealizedPnl)}
                      </span>
                    </td>
                    <td className="num">
                      <span className={`badge ${isUp ? 'up' : 'down'}`}>
                        {isUp ? '+' : ''}{pnlPct.toFixed(2)}%
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn icon"
                        onClick={() => handleSell(p)}
                        disabled={selling === p.tokenAddress}
                        style={{ color: 'var(--down)', background: 'var(--down-bg)' }}
                      >
                        {selling === p.tokenAddress ? 'Menjual…' : 'Jual'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!myPositions.length && (
          <div className="empty" style={{ padding: 32 }}>
            <IconBriefcase size={32} />
            Belum ada posisi. Beli token dari halaman Trade.
          </div>
        )}
        {myPositions.length > 0 && !displayPositions.length && (
          <div className="empty" style={{ padding: 32 }}>
            Tidak ada posisi yang cocok dengan &quot;{posQuery}&quot;.
          </div>
        )}
      </div>

      {/* Riwayat Transaksi */}
      <div className="card">
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>Riwayat Transaksi ({displayFilledOrders.length}{data?.ordersTotal && data.ordersTotal > displayFilledOrders.length ? ` / ${data.ordersTotal}` : ''})</span>
          {hasMoreOrders && (
            <button className="btn" style={{ minHeight: 32, padding: '4px 12px', fontSize: 12 }} onClick={loadMoreOrders} disabled={loadingMoreOrders}>
              {loadingMoreOrders ? 'Memuat…' : 'Muat Riwayat Lama'}
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Tipe</th>
                <th>Token</th>
                <th className="num">Harga</th>
                <th className="num">Jumlah</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {displayFilledOrders.map((o) => (
                <tr key={o.id}>
                  <td>{new Date(o.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`badge ${o.side === 'buy' ? 'up' : 'down'}`}>{o.side.toUpperCase()}</span>
                    <span className="chip" style={{ marginLeft: 4, textTransform: 'capitalize' }}>{o.type}</span>
                  </td>
                  <td><strong>{o.symbol ?? '—'}</strong></td>
                  <td className="num">{Number.isFinite(Number(o.price)) ? fmt.usd(Number(o.price)) : '—'}</td>
                  <td className="num">{Number.isFinite(Number(o.amount)) ? Number(o.amount).toFixed(4) : '—'}</td>
                  <td className="num">{Number.isFinite(Number(o.usdAmount)) ? fmt.usd(Number(o.usdAmount)) : '—'}</td>
                  <td>
                    <span className="chip" style={{ background: 'var(--up-bg)', color: 'var(--up)' }}>Filled</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!displayFilledOrders.length && (
          <div className="empty" style={{ padding: 32 }}>
            <IconScroll size={32} />
            Belum ada transaksi yang tereksekusi.
          </div>
        )}
      </div>
    </>
  );
}