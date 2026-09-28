import { useState, useCallback, useEffect } from 'react';
import { api, Market } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { IconArrowDown, IconArrowUp, IconInfo } from '../components/Icons';
import { fmt } from '../lib/format';
import { useEvmWallet } from '../components/EvmWalletContext';
import { RealTradeForm } from '../components/RealTradeForm';
import { RealWalletBalance } from '../components/RealWalletBalance';

interface Props {
  prefill?: { market: Market; nonce: number } | null;
}

export function Trade({ prefill }: Props) {
  const { realMode, loaded } = useEvmWallet();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [tokenAddr, setTokenAddr] = useState('');
  const [chain, setChain] = useState('base');
  const [amountUsd, setAmountUsd] = useState('');
  const [amountTokens, setAmountTokens] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [liveToken, setLiveToken] = useState<Market | null>(null);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState('');

  // In REAL mode the virtual ledger is not rendered — skip its polling entirely
  // (same short-circuit as Portfolio) so we don't hit /api/portfolio every 5s.
  const portfolioP = usePolling(() => (realMode ? Promise.resolve(undefined) : api.portfolio()), 5_000, [realMode]);
  const watchlistP = usePolling(() => api.watchlist(), 15_000, []);
  const portfolio = portfolioP.data;
  const watchlist = watchlistP.data;
  const wallet = portfolio?.wallet;
  const orders = portfolio?.orders;
  const positions = portfolio?.positions;

  const fetchPrice = useCallback(async (addr: string) => {
    if (!addr.trim()) return;
    setLoadingPrice(true);
    setErr('');
    try {
      const searchRes = await api.search(addr.trim());
      if (searchRes.length > 0) {
        setLiveToken(searchRes[0]);
        if (!targetPrice) setTargetPrice(searchRes[0].priceUsd.toString());
      } else {
        setLiveToken(null);
        setErr('Token tidak ditemukan di DexScreener');
      }
    } catch {
      setErr('Gagal mengambil harga token');
      setLiveToken(null);
    } finally {
      setLoadingPrice(false);
    }
  }, [targetPrice]);

  // Prefill from Overview ⚡ Trade: fill form + fetch price on mount/nonce change.
  useEffect(() => {
    const m = prefill?.market;
    if (!m) return;
    setTokenAddr(m.tokenAddress);
    setChain(m.chainId);
    setLiveToken(m);
    setAmountUsd('');
    setAmountTokens('');
    setTargetPrice('');
    fetchPrice(m.tokenAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const handleUsdChange = useCallback((val: string) => {
    setAmountUsd(val);
    const num = parseFloat(val);
    const price = orderType === 'limit' && targetPrice ? parseFloat(targetPrice) : liveToken?.priceUsd;
    if (!isNaN(num) && price && price > 0) {
      setAmountTokens((num / price).toFixed(6));
    } else {
      setAmountTokens('');
    }
  }, [orderType, targetPrice, liveToken?.priceUsd]);

  const handleTokensChange = useCallback((val: string) => {
    setAmountTokens(val);
    const num = parseFloat(val);
    const price = orderType === 'limit' && targetPrice ? parseFloat(targetPrice) : liveToken?.priceUsd;
    if (!isNaN(num) && price && price > 0) {
      setAmountUsd((num * price).toFixed(2));
    } else {
      setAmountUsd('');
    }
  }, [orderType, targetPrice, liveToken?.priceUsd]);

  const handlePercentage = (pct: number) => {
    if (side === 'buy') {
      const maxUsd = wallet?.available ?? 0;
      handleUsdChange(((maxUsd * pct) / 100).toFixed(2));
    } else {
      const currentPos = positions?.find((p) => p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase());
      const maxTokens = currentPos?.amount ?? 0;
      handleTokensChange(((maxTokens * pct) / 100).toFixed(6));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!liveToken) { setErr('Pilih atau cari token terlebih dahulu'); return; }
    const usd = parseFloat(amountUsd);
    const tokens = parseFloat(amountTokens);
    if (isNaN(usd) || usd <= 0 || isNaN(tokens) || tokens <= 0) { setErr('Masukkan jumlah yang valid'); return; }

    setSubmitting(true);
    setErr('');
    setSuccess('');
    try {
      if (orderType === 'market') {
        const res = await api.marketOrder({ side, tokenAddress: liveToken.tokenAddress, chainId: liveToken.chainId, symbol: liveToken.symbol ?? 'UNKNOWN', name: liveToken.name ?? undefined, usdAmount: usd, tokenAmount: tokens });
        setSuccess(`Order ${side.toUpperCase()} berhasil! ${tokens.toFixed(4)} ${liveToken.symbol} @ $${res.price.toFixed(4)}`);
      } else {
        const target = parseFloat(targetPrice);
        if (isNaN(target) || target <= 0) { setErr('Target price harus lebih dari 0'); setSubmitting(false); return; }
        await api.limitOrder({ side, tokenAddress: liveToken.tokenAddress, chainId: liveToken.chainId, symbol: liveToken.symbol ?? 'UNKNOWN', name: liveToken.name ?? undefined, targetPrice: target, usdAmount: usd, tokenAmount: tokens });
        setSuccess(`Limit order ${side.toUpperCase()} dipasang @ $${target.toFixed(4)}`);
      }
      setAmountUsd('');
      setAmountTokens('');
    } catch (e: any) {
      setErr(e.message ?? 'Gagal membuat order');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.cancelOrder(id);
      setSuccess('Order berhasil dibatalkan');
    } catch (e: any) {
      setErr(e.message ?? 'Gagal membatalkan order');
    }
  };

  const openOrders = (orders ?? []).filter((o) => o.status === 'open');
  const myPosition = positions?.find((p) => p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase());

  // Mode not resolved yet (realMode loads async) — render a skeleton instead of
  // flashing the wrong form (virtual form → real form swap is jarring).
  if (!loaded) {
    return (
      <>
        <div className="page-head">
          <h1>Trade</h1>
          <p>Memuat mode wallet…</p>
        </div>
        <div className="kpi-grid">
          <div className="card kpi skeleton-row" style={{ height: 320 }} />
        </div>
      </>
    );
  }

  // REAL mode → this page trades real funds via the unified form (Jupiter +
  // MetaMask). The virtual form below is not rendered in this branch (its poll
  // short-circuits via the realMode guard above). User: "implementasikan kalo
  // user trade pake real wallet".
  if (realMode) {
    return (
      <>
        <div className="page-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>Trade</h1>
            <span className="chip" style={{ background: 'var(--down-bg)', color: 'var(--down)', fontSize: 11, fontWeight: 700, border: '1px solid rgba(239,68,68,.4)' }}>
              REAL · METAMASK
            </span>
          </div>
          <p>Dana asli via 1inch + MetaMask — server tidak pernah memegang private key, kamu approve tiap transaksi di wallet. Ganti ke virtual lewat banner atas atau panel Real Wallet.</p>
        </div>

        {/* Class (not inline) so the ≤1024px media query can stack it on mobile. */}
        <div className="responsive-split">
          <RealTradeForm />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ padding: 18 }}>
              <strong style={{ display: 'block', fontSize: 14, marginBottom: 10 }}>Saldo On-Chain</strong>
              <RealWalletBalance />
            </div>

            <div className="card" style={{ padding: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}><IconInfo size={15} /> Cara Kerja Real Trading:</strong>
              • <strong>Buat intent</strong> → approve di MetaMask → tx dikirim on-chain (dibangun 1inch, ditandatangani wallet kamu).<br />
              • <strong>Limit order &amp; TP/SL otomatis</strong> hanya tersedia di mode virtual (paper).<br />
              • <strong>BUY</strong> memakai ETH (sisakan ~0.005 ETH untuk gas); <strong>SELL</strong> memakai jumlah token dari wallet.<br />
              • Slippage dikunci server-side maksimum 1% untuk intent otomatis.
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Trade (Virtual Money)</h1>
        <p>Paper trading realtime menggunakan data DexScreener — saldo virtual bisa diatur di halaman Portfolio.</p>
      </div>

      <div className="card" style={{ padding: '16px 20px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <span style={{ color: 'var(--muted)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Tersedia: </span>
          <span style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-heading)', color: 'var(--accent)' }}>${(wallet?.available ?? 100).toFixed(2)} USDC</span>
          {(wallet?.reservedUsd ?? 0) > 0 && (
            <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>
              · {fmt.usd(wallet!.reservedUsd)} terkunci di limit order
            </span>
          )}
        </div>
        <div>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>Total Portofolio: </span>
          <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>${(wallet?.totalValue ?? 100).toFixed(2)}</span>
        </div>
      </div>

      <div className="responsive-split">
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 18 }}>
            <button type="button" className="btn" style={{ background: side === 'buy' ? 'var(--up)' : 'var(--panel-2)', color: side === 'buy' ? '#000' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('buy'); setAmountUsd(''); setAmountTokens(''); }}><IconArrowUp size={13} /> BUY</button>
            <button type="button" className="btn" style={{ background: side === 'sell' ? 'var(--down)' : 'var(--panel-2)', color: side === 'sell' ? '#fff' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('sell'); setAmountUsd(''); setAmountTokens(''); }}><IconArrowDown size={13} /> SELL</button>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <button type="button" className={`btn${orderType === 'market' ? ' primary' : ''}`} style={{ flex: 1, minHeight: 38, fontSize: 13 }} onClick={() => setOrderType('market')}>Market</button>
            <button type="button" className={`btn${orderType === 'limit' ? ' primary' : ''}`} style={{ flex: 1, minHeight: 38, fontSize: 13 }} onClick={() => setOrderType('limit')}>Limit</button>
          </div>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>PILIH TOKEN</label>
              <div className="row">
                <input className="input" style={{ flex: 1 }} placeholder="Cari symbol atau address…" value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)} onBlur={() => fetchPrice(tokenAddr)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), fetchPrice(tokenAddr))} />
                <button type="button" className="btn" onClick={() => fetchPrice(tokenAddr)} disabled={loadingPrice}>{loadingPrice ? '…' : 'Cek'}</button>
              </div>
              {watchlist && watchlist.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {watchlist.slice(0, 5).map((w) => (
                    <button key={w.tokenAddress} type="button" className="chip" style={{ border: 'none', cursor: 'pointer' }} onClick={() => { setTokenAddr(w.tokenAddress); setChain(w.chainId); fetchPrice(w.tokenAddress); }}>{w.symbol ?? 'Token'}</button>
                  ))}
                </div>
              )}
            </div>

            {liveToken && (
              <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <strong>{liveToken.symbol} ({liveToken.chainId})</strong>
                  <span style={{ fontFamily: 'var(--font-heading)', color: 'var(--accent)' }}>${liveToken.priceUsd.toFixed(4)}</span>
                </div>
                {side === 'sell' && myPosition && <div style={{ color: 'var(--muted)', fontSize: 12 }}>Posisi Anda: {myPosition.amount.toFixed(4)} {myPosition.symbol} (~${(myPosition.amount * liveToken.priceUsd).toFixed(2)})</div>}
              </div>
            )}

            {orderType === 'limit' && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>TARGET HARGA (USD)</label>
                <input type="number" step="any" className="input" style={{ width: '100%' }} placeholder="Contoh: 140.50" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} required />
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>{side === 'buy' ? 'JUMLAH BELI (USDC)' : 'ESTIMASI NILAI (USDC)'}</label>
              <input type="number" step="any" className="input" style={{ width: '100%' }} placeholder="0.00" value={amountUsd} onChange={(e) => handleUsdChange(e.target.value)} required />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 14 }}>
              {[25, 50, 75, 100].map((pct) => (
                <button key={pct} type="button" className="btn" style={{ minHeight: 34, padding: '4px', fontSize: 12 }} onClick={() => handlePercentage(pct)}>{pct}%</button>
              ))}
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>{side === 'buy' ? 'ESTIMASI TOKEN DIPEROLEH' : 'JUMLAH TOKEN DIJUAL'}</label>
              <input type="number" step="any" className="input" style={{ width: '100%' }} placeholder="0.000000" value={amountTokens} onChange={(e) => handleTokensChange(e.target.value)} required />
            </div>

            {err && <div className="error" style={{ marginBottom: 14 }}>{err}</div>}
            {success && <div style={{ background: 'var(--up-bg)', color: 'var(--up)', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>✓ {success}</div>}

            <button type="submit" className="btn" disabled={submitting || !liveToken} style={{ width: '100%', background: side === 'buy' ? 'var(--up)' : 'var(--down)', color: side === 'buy' ? '#000' : '#fff', fontSize: 15, fontWeight: 700 }}>{submitting ? 'Memproses…' : `${side === 'buy' ? 'Beli' : 'Jual'} ${liveToken?.symbol ?? ''} (${orderType.toUpperCase()})`}</button>
          </form>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>Open Limit Orders ({openOrders.length})</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tipe</th><th>Token</th><th className="num">Target</th><th className="num">Jumlah</th><th className="num">Total</th><th></th></tr></thead>
                <tbody>
                  {openOrders.map((o) => (
                    <tr key={o.id}>
                      <td><span className={`badge ${o.side === 'buy' ? 'up' : 'down'}`}>{o.side.toUpperCase()}</span></td>
                      <td><strong>{o.symbol}</strong></td>
                      <td className="num">${o.targetPrice?.toFixed(4)}</td>
                      <td className="num">{o.amount.toFixed(4)}</td>
                      <td className="num">${o.usdAmount.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}><button className="btn icon" onClick={() => handleCancel(o.id)} style={{ color: 'var(--down)', background: 'rgba(239, 68, 68, .1)' }}>Batal</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!openOrders.length && <div className="empty" style={{ padding: 24 }}>Tidak ada limit order yang pending.</div>}
          </div>

          <div className="card" style={{ padding: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}><IconInfo size={15} /> Cara Kerja Virtual Trading:</strong>
            • <strong>Market Order:</strong> Langsung dieksekusi pada harga live DexScreener saat ini.<br />
            • <strong>Limit Order:</strong> Menunggu harga pasar menyentuh target harga (diperiksa tiap 15 detik).<br />
            • Saldo virtual terisolasi di memori, tidak menggunakan modal nyata.
          </div>
        </div>
      </div>
    </>
  );
}