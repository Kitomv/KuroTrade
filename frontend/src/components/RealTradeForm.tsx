// Real-wallet trade form — the REAL branch of the Trade page. Mirrors the
// virtual form's layout (side toggle, token row, amount + % buttons, submit)
// but executes real Jupiter swaps: the server builds the tx, Phantom signs it.
// Private keys never leave the wallet.
// Importers/callers: Trade.tsx (rendered when realMode is ON).
// API/data: api.realQuote / api.realSwapTx + wallet-adapter RPC reads (SOL
// balance, token accounts, mint decimals) + RealWalletContext bind state.
// User instruction: "implementasikan kalo user trade pake real wallet" —
// unified form, amounts in SOL / token units (no USD input).
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { api, Market, WatchEntry } from '../api/client';
import { IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconInfo, IconLock } from './Icons';
import { WalletButton } from './WalletButton';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './ToastProvider';
import { useRealWallet } from './RealWalletContext';
import { SOL_MINT, LAMPORTS_PER_SOL, isInsecureOrigin, solscanTxUrl } from '../lib/solana';

// `buffer` polyfill (vite alias) — provide the type so tsc accepts it.
declare const Buffer: { from(data: string, encoding: 'base64'): Uint8Array };

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Keep this much SOL untouched on a max-spend BUY (rent + fees). */
const SOL_GAS_RESERVE = 0.02;

type QuoteResult = {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routeLabels: string[];
  slippageBps: number;
  rawQuote: unknown;
};

interface Props {
  prefill?: { market: Market; nonce: number } | null;
  /** Watchlist chips (owned by Trade.tsx — avoids a second poll). */
  watchlist?: WatchEntry[];
}

export function RealTradeForm({ prefill, watchlist }: Props) {
  const { connected, publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { isBound, binding, bindError, bindWallet } = useRealWallet();
  const confirmAction = useConfirm();
  const toast = useToast();
  const insecure = isInsecureOrigin();

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [query, setQuery] = useState('');
  const [token, setToken] = useState<Market | null>(null);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState('');
  const [slippagePct, setSlippagePct] = useState(1);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState<{ sig: string } | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const [tokenAccounts, setTokenAccounts] = useState<Map<string, { uiAmount: number; decimals: number }>>(new Map());
  const [decimals, setDecimals] = useState<number | null>(null);

  const runningRef = useRef(false); // single-flight: one Phantom popup at a time
  const wl = watchlist ?? [];
  const held = token ? tokenAccounts.get(token.tokenAddress) : undefined;

  // On-chain balances: SOL + SPL accounts (uiAmount + decimals per mint).
  const refreshBalances = useCallback(async () => {
    if (!publicKey) { setSol(null); setTokenAccounts(new Map()); return; }
    try {
      const [lamports, accounts] = await Promise.all([
        connection.getBalance(publicKey),
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
      ]);
      setSol(lamports / LAMPORTS_PER_SOL);
      const map = new Map<string, { uiAmount: number; decimals: number }>();
      for (const a of accounts.value) {
        const info = (a.account.data as any)?.parsed?.info;
        if (!info) continue;
        const ui = Number(info.tokenAmount?.uiAmount) || 0;
        if (ui > 0) map.set(String(info.mint), { uiAmount: ui, decimals: Number(info.tokenAmount?.decimals) || 0 });
      }
      setTokenAccounts(map);
    } catch {
      // RPC hiccup — keep the previous values.
    }
  }, [publicKey, connection]);

  useEffect(() => { refreshBalances(); }, [refreshBalances]);

  // Mint decimals: prefer the wallet's own token account, else read the mint
  // account. Needed to convert token units → atomic units for SELL and to
  // humanize the quote output for BUY.
  useEffect(() => {
    if (!token) { setDecimals(null); return; }
    const heldDecimals = tokenAccounts.get(token.tokenAddress)?.decimals;
    if (heldDecimals !== undefined) { setDecimals(heldDecimals); return; }
    let cancelled = false;
    (async () => {
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(token.tokenAddress));
        const d = (info.value?.data as any)?.parsed?.info?.decimals;
        if (!cancelled) setDecimals(Number.isFinite(Number(d)) ? Number(d) : null);
      } catch {
        if (!cancelled) setDecimals(null);
      }
    })();
    return () => { cancelled = true; };
  }, [token, tokenAccounts, connection]);

  // Prefill from Overview ⚡ Trade (same contract as the virtual form).
  useEffect(() => {
    const m = prefill?.market;
    if (!m) return;
    if (m.chainId !== 'solana') { setErr('Real trading hanya untuk token Solana.'); return; }
    setToken(m);
    setQuery(m.symbol ?? m.tokenAddress);
    setSide('buy');
    setAmount('');
    setQuote(null);
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const searchToken = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setErr('');
    setQuote(null);
    try {
      const res = await api.search(query.trim());
      // Real mode is Solana-only (Jupiter).
      const solana = res.find((m) => m.chainId === 'solana') ?? null;
      if (!solana) { setErr('Token Solana tidak ditemukan di DexScreener'); setToken(null); return; }
      setToken(solana);
    } catch {
      setErr('Gagal mencari token');
      setToken(null);
    } finally {
      setSearching(false);
    }
  };

  const pickWatch = async (w: WatchEntry) => {
    setErr('');
    setQuote(null);
    setQuery(w.symbol ?? w.tokenAddress);
    if (w.market && w.market.chainId === 'solana') { setToken(w.market); return; }
    setSearching(true);
    try {
      const res = await api.search(w.tokenAddress);
      const solana = res.find((m) => m.chainId === 'solana') ?? null;
      setToken(solana);
      if (!solana) setErr('Token Solana tidak ditemukan');
    } catch {
      setErr('Gagal mencari token');
    } finally {
      setSearching(false);
    }
  };

  const changeSide = (s: 'buy' | 'sell') => { setSide(s); setAmount(''); setQuote(null); setErr(''); };

  const getQuote = async () => {
    if (!token) { setErr('Pilih token dulu'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setErr('Jumlah tidak valid'); return; }
    if (side === 'buy') {
      if (sol !== null && amt > sol - SOL_GAS_RESERVE) { setErr(`Saldo SOL tidak cukup — sisakan ~${SOL_GAS_RESERVE} SOL untuk gas.`); return; }
    } else {
      if (!held) { setErr('Kamu tidak punya token ini di wallet'); return; }
      if (amt > held.uiAmount) { setErr(`Saldo token tidak cukup (punya ${held.uiAmount}).`); return; }
      if (decimals === null) { setErr('Desimal token belum terbaca — coba lagi sebentar.'); return; }
    }
    setQuoting(true);
    setErr('');
    setQuote(null);
    try {
      const inputMint = side === 'buy' ? SOL_MINT : token.tokenAddress;
      const outputMint = side === 'buy' ? token.tokenAddress : SOL_MINT;
      const rawAmount = side === 'buy'
        ? Math.floor(amt * LAMPORTS_PER_SOL)
        : Math.floor(amt * Math.pow(10, decimals ?? 0));
      const q = await api.realQuote({ inputMint, outputMint, amount: rawAmount, slippageBps: Math.round(slippagePct * 100) });
      setQuote(q);
    } catch (e: any) {
      setErr(e.message ?? 'Gagal mengambil quote');
    } finally {
      setQuoting(false);
    }
  };

  const executeSwap = async () => {
    if (!quote || !token || !publicKey || !signTransaction) return;
    if (insecure) { setErr('Koneksi tidak aman (http/ngrok). Jangan trade real di sini.'); return; }
    if (!isBound) { setErr('Bind wallet dulu sebelum swap dana asli.'); return; }
    if (runningRef.current) return;

    const impact = Math.abs(parseFloat(quote.priceImpactPct) || 0) * 100;
    const sideLabel = side === 'buy' ? 'BUY' : 'SELL';
    const ok = await confirmAction({
      title: `Konfirmasi ${sideLabel} ${token.symbol} · REAL`,
      message: (
        <>
          Swap {sideLabel} {token.symbol} pakai <strong>dana asli</strong> via Jupiter — kamu approve di Phantom.
          {impact > 3 && <span style={{ color: 'var(--down)', fontWeight: 600 }}> Price impact tinggi: {impact.toFixed(2)}%.</span>}
        </>
      ),
      confirmLabel: `${sideLabel} di Phantom`,
      danger: side === 'sell' || impact > 3,
    });
    if (!ok) return;

    runningRef.current = true;
    setSwapping(true);
    setErr('');
    setSuccess(null);
    try {
      const { swapTransaction } = await api.realSwapTx({ quoteResponse: quote.rawQuote, userPublicKey: publicKey.toBase58() });
      const bytes = Uint8Array.from(Buffer.from(swapTransaction, 'base64'));
      const tx = VersionedTransaction.deserialize(bytes);
      const signed = await signTransaction(tx);

      // Simulate before sending — catch failures without paying fees.
      const sim = await connection.simulateTransaction(signed);
      if (sim.value.err) throw new Error(`Simulasi gagal: ${JSON.stringify(sim.value.err).slice(0, 160)}`);

      const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 2 });
      await connection.confirmTransaction(sig, 'confirmed');
      setSuccess({ sig });
      setQuote(null);
      setAmount('');
      toast.showToast(`${sideLabel} ${token.symbol} terkonfirmasi`, 'success');
      refreshBalances();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) setErr('Dibatalkan di Phantom');
      else setErr(msg.slice(0, 200));
    } finally {
      runningRef.current = false;
      setSwapping(false);
    }
  };

  const handlePercentage = (pct: number) => {
    setQuote(null);
    if (side === 'buy') {
      const maxSol = Math.max(0, (sol ?? 0) - SOL_GAS_RESERVE);
      setAmount(((maxSol * pct) / 100).toFixed(4));
    } else {
      setAmount((((held?.uiAmount ?? 0) * pct) / 100).toFixed(6));
    }
  };

  const impactPct = quote ? Math.abs(parseFloat(quote.priceImpactPct) || 0) * 100 : 0;
  const outHuman = useMemo(() => {
    if (!quote) return '';
    const raw = Number(quote.outAmount);
    if (!Number.isFinite(raw)) return quote.outAmount;
    const div = side === 'sell' ? LAMPORTS_PER_SOL : Math.pow(10, decimals ?? 0);
    const human = raw / div;
    return human.toLocaleString(undefined, { maximumFractionDigits: human < 1 ? 6 : 4 });
  }, [quote, side, decimals]);

  if (!connected) {
    return (
      <div className="card" style={{ padding: 22 }}>
        <div className="empty" style={{ padding: 24 }}>
          Connect Phantom dulu untuk trade dana asli. Server tidak pernah memegang private key — kamu approve tiap transaksi di wallet.
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}><WalletButton /></div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 22 }}>
      {insecure && (
        <div className="error" style={{ margin: '0 0 14px', width: '100%', justifyContent: 'center' }}>
          <IconAlert size={14} /> Koneksi tidak aman — jangan trade real lewat http/ngrok. Pakai https atau localhost.
        </div>
      )}
      {!isBound && (
        <div className="error" style={{ margin: '0 0 14px', width: '100%', background: 'rgba(245,158,11,.14)', color: 'var(--accent)', justifyContent: 'space-between' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconLock size={13} /> Bind wallet dulu untuk swap dana asli.</span>
          <button type="button" className="btn primary" style={{ minHeight: 30, padding: '3px 12px', fontSize: 12 }} disabled={binding} onClick={() => bindWallet()}>
            {binding ? 'Menunggu…' : 'Bind Wallet'}
          </button>
        </div>
      )}
      {bindError && <div className="error" style={{ margin: '0 0 14px', width: '100%' }}><IconAlert size={14} /> {bindError}</div>}

      <div className="grid-2" style={{ marginBottom: 18 }}>
        <button type="button" className="btn" style={{ background: side === 'buy' ? 'var(--up)' : 'var(--panel-2)', color: side === 'buy' ? '#000' : 'var(--text)', fontWeight: 700 }} onClick={() => changeSide('buy')}>
          <IconArrowUp size={13} /> BUY (SOL → token)
        </button>
        <button type="button" className="btn" style={{ background: side === 'sell' ? 'var(--down)' : 'var(--panel-2)', color: side === 'sell' ? '#fff' : 'var(--text)', fontWeight: 700 }} onClick={() => changeSide('sell')}>
          <IconArrowDown size={13} /> SELL (token → SOL)
        </button>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>PILIH TOKEN (SOLANA)</label>
        <div className="row">
          <input className="input" style={{ flex: 1 }} placeholder="Cari symbol atau mint address…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), searchToken())} />
          <button type="button" className="btn" onClick={searchToken} disabled={searching}>{searching ? '…' : 'Cek'}</button>
        </div>
        {wl.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {wl.slice(0, 5).map((w) => (
              <button key={w.tokenAddress} type="button" className="chip" style={{ border: 'none', cursor: 'pointer' }} onClick={() => pickWatch(w)}>{w.symbol ?? 'Token'}</button>
            ))}
          </div>
        )}
      </div>

      {token && (
        <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
            <strong>{token.symbol} ({token.chainId})</strong>
            <span style={{ fontFamily: 'var(--font-heading)', color: 'var(--accent)' }}>${token.priceUsd?.toFixed(6)}</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            {side === 'buy'
              ? `Wallet: ${sol === null ? '…' : sol.toFixed(4)} SOL`
              : `Posisi wallet: ${held ? `${held.uiAmount} ${token.symbol ?? ''}` : '0'}`}
          </div>
        </div>
      )}

      <div className="grid-2-1" style={{ marginBottom: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>
            {side === 'buy' ? 'JUMLAH SOL' : 'JUMLAH TOKEN'}
          </label>
          <input type="number" step="any" className="input" style={{ width: '100%' }} placeholder={side === 'buy' ? '0.05' : '1000'} value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>SLIPPAGE %</label>
          <input type="number" step="0.1" min={0.1} max={5} className="input" style={{ width: '100%' }} value={slippagePct} onChange={(e) => setSlippagePct(Math.min(5, Math.max(0.1, parseFloat(e.target.value) || 1)))} />
        </div>
      </div>

      <div className="grid-4" style={{ marginBottom: 14 }}>
        {[25, 50, 75, 100].map((pct) => (
          <button key={pct} type="button" className="btn" style={{ minHeight: 34, padding: '4px', fontSize: 12 }} onClick={() => handlePercentage(pct)}>{pct}%</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={getQuote} disabled={quoting || !token || !amount}>
          {quoting ? 'Mengambil quote…' : 'Estimate'}
        </button>
        <button type="button" className="btn primary" style={{ flex: 1, fontWeight: 700 }} onClick={executeSwap} disabled={swapping || !quote || !isBound || insecure}>
          {swapping ? 'Menunggu Phantom…' : `${side === 'buy' ? 'Beli' : 'Jual'} ${token?.symbol ?? ''} · REAL`}
        </button>
      </div>

      {quote && (
        <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 12, lineHeight: 1.7 }}>
          <div>
            {side === 'buy' ? 'Dapat ≈ ' : 'Terima ≈ '}
            <strong>{outHuman}</strong> {side === 'buy' ? `${token?.symbol ?? ''}${decimals === null ? ' (satuan terkecil)' : ''}` : 'SOL'}
          </div>
          <div>
            Price impact:{' '}
            <span style={{ color: impactPct > 3 ? 'var(--down)' : 'var(--up)', fontWeight: 700 }}>{impactPct.toFixed(2)}%</span>
            {impactPct > 3 && <span style={{ color: 'var(--down)' }}> (tinggi!)</span>}
          </div>
          {quote.routeLabels.length > 0 && <div style={{ color: 'var(--muted)' }}>Route: {quote.routeLabels.join(' → ')}</div>}
        </div>
      )}

      {err && <div className="error" style={{ margin: '0 0 12px', width: '100%' }}><IconAlert size={14} /> {err}</div>}

      {success && (
        <div style={{ background: 'var(--up-bg)', color: 'var(--up)', padding: 12, borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <IconCheck size={14} /> Tx terkonfirmasi!
          <a href={solscanTxUrl(success.sig)} target="_blank" rel="noreferrer" style={{ color: 'var(--up)', textDecoration: 'underline' }}>Lihat di Solscan</a>
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconInfo size={13} /> Tx disimulasikan dulu sebelum dikirim · Limit order hanya tersedia di mode virtual.
      </p>
    </div>
  );
}
