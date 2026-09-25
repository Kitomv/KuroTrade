// Real trading panel — Phantom + Jupiter. The server builds the tx; the wallet
// signs it. Private keys never leave the wallet.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { api, Market, RealIntent } from '../api/client';
import { IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconZap } from './Icons';
import { WalletButton } from './WalletButton';
import { useConfirm } from './ConfirmDialog';
import { useRealWallet } from './RealWalletContext';
import { SOL_MINT, LAMPORTS_PER_SOL, isInsecureOrigin, solscanTxUrl } from '../lib/solana';

// `buffer` polyfill (vite alias) — provide the type so tsc accepts it.
declare const Buffer: { from(data: string, encoding: 'base64'): Uint8Array };

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

type QuoteResult = {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routeLabels: string[];
  slippageBps: number;
  rawQuote: unknown;
};

export function RealTradePanel() {
  const { connected, publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { isBound } = useRealWallet();
  const confirmAction = useConfirm();

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
  // SELL quotes need mint decimals to convert human token units → atomic units.
  // Without this the panel quoted `amt` as already-atomic, selling 10^decimals
  // times less than the user typed (1e-9 of a 9-decimal token).
  const [decimals, setDecimals] = useState<number | null>(null);
  const [held, setHeld] = useState<number | null>(null);

  const runningRef = useRef(false); // single-flight: one Phantom popup at a time
  const insecure = isInsecureOrigin();

  // Resolve mint decimals + on-chain balance so SELL can be validated and
  // converted before quoting (mirrors RealTradeForm's resolution order).
  useEffect(() => {
    if (!token) { setDecimals(null); setHeld(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(token.tokenAddress));
        const d = (info.value?.data as any)?.parsed?.info?.decimals;
        if (!cancelled) setDecimals(Number.isFinite(Number(d)) ? Number(d) : null);
      } catch {
        if (!cancelled) setDecimals(null);
      }
      if (!publicKey) { if (!cancelled) setHeld(null); return; }
      try {
        const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });
        const match = accounts.value.find(
          (a) => String((a.account.data as any)?.parsed?.info?.mint) === token.tokenAddress,
        );
        const ui = Number((match?.account.data as any)?.parsed?.info?.tokenAmount?.uiAmount) || 0;
        if (!cancelled) setHeld(ui);
      } catch {
        if (!cancelled) setHeld(null);
      }
    })();
    return () => { cancelled = true; };
  }, [token, publicKey, connection]);

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

  const getQuote = async () => {
    if (!token) { setErr('Pilih token dulu'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setErr('Jumlah tidak valid'); return; }
    if (side === 'sell') {
      if (held !== null && amt > held) { setErr(`Saldo token tidak cukup (punya ${held}).`); return; }
      if (decimals === null) { setErr('Desimal token belum terbaca — coba lagi sebentar.'); return; }
    }
    setQuoting(true);
    setErr('');
    setQuote(null);
    try {
      const inputMint = side === 'buy' ? SOL_MINT : token.tokenAddress;
      const outputMint = side === 'buy' ? token.tokenAddress : SOL_MINT;
      // BUY: SOL → lamports. SELL: human token units → atomic units (matches
      // RealTradeForm; the server's intent path also speaks human units).
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
    if (!quote || !publicKey || !signTransaction) return;
    if (insecure) { setErr('Koneksi tidak aman (http/ngrok). Jangan trade real di sini.'); return; }
    if (!isBound) { setErr('Bind wallet dulu sebelum swap dana asli.'); return; }
    if (runningRef.current) return; // double-click → only one Phantom popup
    const impact = Math.abs(parseFloat(quote.priceImpactPct) || 0) * 100;
    const sideLabel = side === 'buy' ? 'BUY' : 'SELL';
    const ok = await confirmAction({
      title: `Konfirmasi ${sideLabel} ${token?.symbol}`,
      message: (
        <>
          Swap {sideLabel} {token?.symbol} via Jupiter — kamu approve tiap tx di Phantom.
          {impact > 3 && (
            <span style={{ color: 'var(--down)', fontWeight: 600 }}> Price impact tinggi: {impact.toFixed(2)}%.</span>
          )}
        </>
      ),
      confirmLabel: `${sideLabel} di Phantom`,
      danger: side === 'sell',
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
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setErr('Dibatalkan di Phantom');
      } else {
        setErr(msg.slice(0, 200));
      }
    } finally {
      runningRef.current = false;
      setSwapping(false);
    }
  };

  const impactPct = quote ? Math.abs(parseFloat(quote.priceImpactPct) || 0) * 100 : 0;

  return (
    <div className="card" style={{ padding: 22 }}>
      {insecure && (
        <div className="error" style={{ margin: '0 0 14px', width: '100%', justifyContent: 'center' }}>
          <IconAlert size={14} /> Koneksi tidak aman — jangan trade real lewat http/ngrok. Pakai https atau localhost.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconZap size={15} />
          <strong style={{ fontSize: 14 }}>Real Trading (Jupiter + Phantom)</strong>
        </div>
        <WalletButton compact />
      </div>

      {!connected ? (
        <div className="empty" style={{ padding: 24 }}>
          Connect Phantom dulu untuk trade real. Server tidak pernah memegang private key — kamu approve tiap transaksi di wallet.
        </div>
      ) : (
        <>
          <div className="grid-2" style={{ marginBottom: 14 }}>
            <button type="button" className="btn" style={{ background: side === 'buy' ? 'var(--up)' : 'var(--panel-2)', color: side === 'buy' ? '#000' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('buy'); setQuote(null); setAmount(''); }}>
              <IconArrowUp size={13} /> BUY (SOL → token)
            </button>
            <button type="button" className="btn" style={{ background: side === 'sell' ? 'var(--down)' : 'var(--panel-2)', color: side === 'sell' ? '#fff' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('sell'); setQuote(null); setAmount(''); }}>
              <IconArrowDown size={13} /> SELL (token → SOL)
            </button>
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 160 }}
              placeholder="Cari token Solana (symbol / mint address)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), searchToken())}
            />
            <button type="button" className="btn" onClick={searchToken} disabled={searching}>{searching ? '…' : 'Cari'}</button>
          </div>

          {token && (
            <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong>{token.symbol} ({token.chainId})</strong>
              <span style={{ fontFamily: 'var(--font-heading)', color: 'var(--accent)' }}>${token.priceUsd?.toFixed(6)}</span>
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

          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={getQuote} disabled={quoting || !token || !amount}>
              {quoting ? 'Mengambil quote…' : 'Get Quote'}
            </button>
            <button type="button" className="btn primary" style={{ flex: 1, fontWeight: 700 }} onClick={executeSwap} disabled={swapping || !quote}>
              {swapping ? 'Menunggu Phantom…' : 'Approve & Swap'}
            </button>
          </div>

          {quote && (
            <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 12, lineHeight: 1.7 }}>
              <div>In: <strong>{quote.inAmount}</strong> → Out: <strong>{quote.outAmount}</strong></div>
              <div>
                Price impact:{' '}
                <span style={{ color: impactPct > 3 ? 'var(--down)' : 'var(--up)', fontWeight: 700 }}>
                  {impactPct.toFixed(2)}%
                </span>
                {impactPct > 3 && <span style={{ color: 'var(--down)' }}> (tinggi!)</span>}
              </div>
              {quote.routeLabels.length > 0 && <div style={{ color: 'var(--muted)' }}>Route: {quote.routeLabels.join(' → ')}</div>}
            </div>
          )}

          {err && <div className="error" style={{ margin: '0 0 12px', width: '100%' }}><IconAlert size={14} /> {err}</div>}

          {success && (
            <div style={{ background: 'var(--up-bg)', color: 'var(--up)', padding: 12, borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <IconCheck size={14} /> Tx terkonfirmasi!
              <a href={solscanTxUrl(success.sig)} target="_blank" rel="noreferrer" style={{ color: 'var(--up)', textDecoration: 'underline' }}>
                Lihat di Solscan
              </a>
            </div>
          )}

          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, marginBottom: 0 }}>
            Paper trading tetap tersedia — real mode memakai dana asli. Tx disimulasikan dulu sebelum dikirim.
          </p>
        </>
      )}
    </div>
  );
}

/** Autopilot intents list — presentational only. The engine (claim → server
 *  swap → Phantom → confirm, plus the auto-execute loop) lives in
 *  RealWalletContext so it survives page navigation and panel closes.
 *  `compact` renders a dense list for the sidebar panel. */
export function PendingIntents({ compact = false }: { compact?: boolean }) {
  const { openIntents, realAuto, approvingId, approveError, approveIntent, cancelIntent } = useRealWallet();

  if (openIntents.length === 0) return null;

  return (
    <div className={compact ? '' : 'card'} style={compact ? undefined : { marginBottom: 16 }}>
      <div style={compact
        ? { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }
        : { padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Intents menunggu approve ({openIntents.length})</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{realAuto ? 'auto-execute' : 'manual'}</span>
      </div>
      {approveError && <div className="error" style={{ margin: '8px 0' }}><IconAlert size={13} /> {approveError}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Token</th><th>Arah</th><th className="num">Harga</th><th className="num">Jumlah</th><th>Confidence AI</th><th></th></tr>
          </thead>
          <tbody>
            {openIntents.map((i) => {
              // Agent/LLM provenance: a BUY must show WHY it is proposed.
              // Sells are exits (SL/TP/rotate) — they carry no buy confidence.
              const isBuy = i.side === 'buy';
              const conf = i.confidence;
              const confTone = conf === undefined ? 'flat' : conf >= 80 ? 'up' : conf >= 70 ? 'flat' : 'down';
              return (
              <tr key={i.id}>
                <td><strong>{i.symbol}</strong><div className="chip" style={{ fontSize: 9, marginTop: 2 }}>{i.source}</div></td>
                <td><span className={`badge ${i.side === 'buy' ? 'up' : 'down'}`}>{i.side.toUpperCase()}</span></td>
                <td className="num">${i.intentPrice?.toFixed(6)}</td>
                <td className="num">{i.side === 'buy' ? `$${i.amountUsd?.toFixed(2)}` : `${i.estTokens?.toFixed(4)}`}</td>
                <td>
                  {isBuy && conf !== undefined ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className={`badge ${confTone}`} style={{ fontWeight: 700 }}>{conf}%</span>
                      <span style={{ fontSize: 9, color: 'var(--muted)' }}>
                        {i.llmPowered ? 'LLM+Quant' : 'Quant'}
                        {typeof i.bullScore === 'number' && typeof i.bearScore === 'number'
                          ? ` · B${i.bullScore}/S${i.bearScore}` : ''}
                      </span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn primary" style={{ marginRight: 4, minHeight: 30, padding: '3px 10px', fontSize: 11 }} disabled={approvingId === i.id} onClick={() => approveIntent(i)}>
                    {approvingId === i.id ? <><span className="spinner" aria-hidden /> Menunggu…</> : 'Approve'}
                  </button>
                  <button className="btn icon" style={{ minHeight: 30, padding: 3, fontSize: 11 }} disabled={approvingId === i.id} onClick={() => cancelIntent(i)}>
                    {approvingId === i.id ? <><span className="spinner" aria-hidden /> Batal…</> : 'Batal'}
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
