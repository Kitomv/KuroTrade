// Real trading panel — MetaMask + 1inch. The panel creates an intent; the
// PendingIntents list below it is where the user actually approves and signs.
// Private keys never leave MetaMask, and the server never signs.
import { useCallback, useState } from 'react';
import { api, Market, RealIntent } from '../api/client';
import { IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconZap } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useEvmWallet } from './EvmWalletContext';
import { shortAddr, isInsecureOrigin } from '../lib/evm';

/** Chains the backend can execute on. Keep in sync with backend CHAINS. */
export const EVM_CHAINS = ['base', 'ethereum', 'arbitrum', 'bsc', 'optimism', 'polygon', 'avalanche'];

export function RealTradePanel() {
  const {
    connected, isBound, address, openIntents, approvingId, approveError,
    approveIntent, cancelIntent, refreshIntents, chainId,
  } = useEvmWallet();
  const confirmAction = useConfirm();

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [query, setQuery] = useState('');
  const [token, setToken] = useState<Market | null>(null);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<RealIntent | null>(null);
  const insecure = isInsecureOrigin();

  const searchToken = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setErr('');
    setCreated(null);
    try {
      const res = await api.search(query.trim());
      // EVM-only execution: a Solana pair cannot be filled by 1inch.
      const evm = res.find((m) => EVM_CHAINS.includes(m.chainId)) ?? null;
      if (!evm) { setErr('Token EVM tidak ditemukan di DexScreener'); setToken(null); return; }
      setToken(evm);
    } catch {
      setErr('Gagal mencari token');
      setToken(null);
    } finally {
      setSearching(false);
    }
  }, [query]);

  const createIntent = async () => {
    if (!token) { setErr('Pilih token dulu'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setErr('Jumlah tidak valid'); return; }
    if (!isBound) { setErr('Bind wallet dulu sebelum trade dana asli.'); return; }

    // BUY: the user types USD. SELL: the user types token units — the intent
    // carries both the token amount and its USD value at the current price.
    const price = Number(token.priceUsd) || 0;
    if (price <= 0) { setErr('Harga token tidak tersedia — coba token lain.'); return; }
    const estTokens = side === 'buy' ? amt / price : amt;
    const amountUsd = side === 'buy' ? amt : amt * price;

    const ok = await confirmAction({
      title: `Konfirmasi ${side === 'buy' ? 'BUY' : 'SELL'} ${token.symbol}`,
      message: (
        <>
          Intent akan dibuat, lalu kamu <strong>approve di MetaMask</strong> untuk menandatangani swap.
          {side === 'buy' ? ` Belanja $${amountUsd.toFixed(2)}.` : ` Jual ${estTokens.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol}.`}
        </>
      ),
      confirmLabel: 'Buat intent',
      danger: side === 'sell',
    });
    if (!ok) return;

    setSubmitting(true);
    setErr('');
    try {
      const intent = await api.manualIntent({
        tokenAddress: token.tokenAddress,
        symbol: token.symbol ?? 'UNKNOWN',
        side,
        amountUsd,
        estTokens,
        intentPrice: price,
        chain: token.chainId,
      });
      setCreated(intent);
      setAmount('');
      await refreshIntents();
    } catch (e: unknown) {
      setErr(String((e as { message?: string })?.message ?? 'Gagal membuat intent'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 22 }}>
        {insecure && (
          <div className="error" style={{ margin: '0 0 14px', width: '100%', justifyContent: 'center' }}>
            <IconAlert size={14} /> Koneksi tidak aman — jangan trade real lewat http/ngrok. Pakai https atau localhost.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconZap size={15} />
            <strong style={{ fontSize: 14 }}>Real Trading (1inch + MetaMask)</strong>
          </div>
          <span className="chip" style={{ fontSize: 10, background: isBound ? 'var(--up-bg)' : 'var(--panel-2)', color: isBound ? 'var(--up)' : 'var(--muted)' }}>
            {connected ? (isBound ? `BOUND ${address ? shortAddr(address, 3) : ''}` : 'BELUM BIND') : 'BELUM CONNECT'}
          </span>
        </div>

        {!connected ? (
          <div className="empty" style={{ padding: 24 }}>
            Connect MetaMask dulu untuk trade real. Server tidak pernah memegang private key — kamu approve tiap transaksi di wallet.
          </div>
        ) : (
          <>
            <div className="grid-2" style={{ marginBottom: 14 }}>
              <button type="button" className="btn" style={{ background: side === 'buy' ? 'var(--up)' : 'var(--panel-2)', color: side === 'buy' ? '#000' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('buy'); setCreated(null); setAmount(''); }}>
                <IconArrowUp size={13} /> BUY (ETH → token)
              </button>
              <button type="button" className="btn" style={{ background: side === 'sell' ? 'var(--down)' : 'var(--panel-2)', color: side === 'sell' ? '#fff' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('sell'); setCreated(null); setAmount(''); }}>
                <IconArrowDown size={13} /> SELL (token → ETH)
              </button>
            </div>

            <div className="row" style={{ marginBottom: 12 }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 160 }}
                placeholder="Cari token EVM (symbol / 0x address)…"
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

            <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>
              {side === 'buy' ? 'BELANJA (USD)' : 'JUMLAH TOKEN'}
            </label>
            <input
              type="number"
              step="any"
              className="input"
              style={{ width: '100%', marginBottom: 12 }}
              placeholder={side === 'buy' ? '10' : '1000'}
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setCreated(null); }}
            />

            <button
              type="button"
              className="btn primary"
              style={{ width: '100%', minHeight: 40, fontWeight: 700 }}
              disabled={submitting || !token}
              onClick={createIntent}
            >
              {submitting ? 'Membuat intent…' : `Buat intent ${side === 'buy' ? 'BUY' : 'SELL'}`}
            </button>

            {chainId && chainId !== '0x2105' && token && token.chainId === 'base' && (
              <p style={{ fontSize: 11, color: 'var(--accent)', marginTop: 10, marginBottom: 0 }}>
                MetaMask kamu di chain {chainId}. Ganti ke Base agar swap tidak gagal di wallet.
              </p>
            )}

            {created && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--up)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconCheck size={13} /> Intent dibuat — approve di daftar bawah untuk menandatangani.
              </div>
            )}
            {err && <div className="error" style={{ marginTop: 12 }}><IconAlert size={13} /> {err}</div>}
          </>
        )}
      </div>

      <PendingIntents
        intents={openIntents}
        approvingId={approvingId}
        approveError={approveError}
        onApprove={approveIntent}
        onCancel={cancelIntent}
      />
    </div>
  );
}

/** Intents waiting for a MetaMask signature — the actual execution surface. */
export function PendingIntents({
  intents, approvingId, approveError, onApprove, onCancel,
}: {
  intents: RealIntent[];
  approvingId: string | null;
  approveError: string;
  onApprove: (i: RealIntent) => void;
  onCancel: (i: RealIntent) => void;
}) {
  if (intents.length === 0) {
    return (
      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 13 }}>Menunggu Approve</strong>
        <div className="empty" style={{ padding: 12, fontSize: 12 }}>
          Tidak ada intent yang menunggu. Autopilot akan mengisi daftar ini saat menemukan sinyal.
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <strong style={{ fontSize: 13 }}>Menunggu Approve ({intents.length})</strong>
      {approveError && <div className="error" style={{ marginTop: 10 }}><IconAlert size={13} /> {approveError}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {intents.map((i) => (
          <div
            key={i.id}
            style={{ background: 'var(--panel-2)', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div>
                <strong style={{ color: i.side === 'buy' ? 'var(--up)' : 'var(--down)' }}>{i.side.toUpperCase()}</strong>
                {' '}{i.symbol} · ${Number(i.amountUsd).toFixed(2)} · {i.chainId}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                sumber {i.source}
                {i.confidence != null && ` · confidence ${i.confidence}%`}
                {i.llmPowered && ' · LLM'}
                {' · '}{new Date(i.createdAt).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" style={{ fontSize: 12, minHeight: 32 }} disabled={approvingId !== null} onClick={() => onCancel(i)}>
                Batalkan
              </button>
              <button
                type="button"
                className="btn primary"
                style={{ fontSize: 12, minHeight: 32, fontWeight: 700 }}
                disabled={approvingId !== null}
                onClick={() => onApprove(i)}
              >
                {approvingId === i.id ? 'Menunggu MetaMask…' : 'Approve di MetaMask'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
