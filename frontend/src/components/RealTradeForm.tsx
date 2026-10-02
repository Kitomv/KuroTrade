// Compact real-trade form for the Trade page, the Agents radar, and the
// Portfolio swap dialog. Creates an intent; the user approves and signs it in
// MetaMask. Private keys never leave the wallet, and the server never signs.
import { useCallback, useState } from 'react';
import { api, Market } from '../api/client';
import { IconAlert, IconCheck, IconArrowDown, IconArrowUp, IconZap } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useEvmWallet } from './EvmWalletContext';
import { shortAddr, isInsecureOrigin } from '../lib/evm';
import { useEvmChains } from '../hooks/useEvmChains';

export function RealTradeForm() {
  const { connected, isBound, address, approveIntent, cancelIntent, openIntents, approvingId, approveError } = useEvmWallet();
  const { keys: evmChains } = useEvmChains();
  const confirmAction = useConfirm();

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [query, setQuery] = useState('');
  const [token, setToken] = useState<Market | null>(null);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const insecure = isInsecureOrigin();

  const searchToken = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setErr('');
    try {
      const res = await api.search(query.trim());
      // Empty list = still loading (see useEvmChains); fall through to the top
      // result and let the server reject an unsupported chain itself.
      const evm = (evmChains.length === 0 ? res[0] : res.find((m) => evmChains.includes(m.chainId))) ?? null;
      if (!evm) { setErr('Token EVM tidak ditemukan'); setToken(null); return; }
      setToken(evm);
    } catch {
      setErr('Gagal mencari token');
      setToken(null);
    } finally {
      setSearching(false);
    }
  }, [query, evmChains]);

  const createIntent = async () => {
    if (!token) { setErr('Pilih token dulu'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setErr('Jumlah tidak valid'); return; }
    if (!isBound) { setErr('Bind wallet dulu (panel Real Wallet).'); return; }
    const price = Number(token.priceUsd) || 0;
    if (price <= 0) { setErr('Harga token tidak tersedia.'); return; }

    const estTokens = side === 'buy' ? amt / price : amt;
    const amountUsd = side === 'buy' ? amt : amt * price;
    const confirmed = await confirmAction({
      title: `Konfirmasi ${side.toUpperCase()} ${token.symbol}`,
      message: 'Intent dibuat, lalu kamu approve di MetaMask untuk menandatangani swap.',
      confirmLabel: 'Buat intent',
      danger: side === 'sell',
    });
    if (!confirmed) return;

    setSubmitting(true);
    setErr('');
    setOk('');
    try {
      await api.manualIntent({
        tokenAddress: token.tokenAddress,
        symbol: token.symbol ?? 'UNKNOWN',
        side,
        amountUsd,
        estTokens,
        intentPrice: price,
        chain: token.chainId,
      });
      setOk(`Intent ${side.toUpperCase()} dibuat — approve di MetaMask.`);
      setAmount('');
    } catch (e: unknown) {
      setErr(String((e as { message?: string })?.message ?? 'Gagal membuat intent'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!connected) {
    return (
      <div className="empty" style={{ padding: 20 }}>
        Connect MetaMask dulu untuk trade dana asli. Private key tetap di wallet kamu.
      </div>
    );
  }

  return (
    <div>
      {insecure && (
        <div className="error" style={{ marginBottom: 12 }}>
          <IconAlert size={13} /> Koneksi tidak aman (http/ngrok) — jangan trade real di sini.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <IconZap size={15} />
        <strong style={{ fontSize: 14 }}>Trade Dana Asli</strong>
        <span className="chip" style={{ fontSize: 10, background: isBound ? 'var(--up-bg)' : 'var(--panel-2)', color: isBound ? 'var(--up)' : 'var(--muted)' }}>
          {isBound ? `BOUND ${address ? shortAddr(address, 3) : ''}` : 'BELUM BIND'}
        </span>
      </div>

      <div className="grid-2" style={{ marginBottom: 12 }}>
        <button type="button" className="btn" style={{ background: side === 'buy' ? 'var(--up)' : 'var(--panel-2)', color: side === 'buy' ? '#000' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('buy'); setOk(''); }}>
          <IconArrowUp size={13} /> BUY
        </button>
        <button type="button" className="btn" style={{ background: side === 'sell' ? 'var(--down)' : 'var(--panel-2)', color: side === 'sell' ? '#fff' : 'var(--text)', fontWeight: 700 }} onClick={() => { setSide('sell'); setOk(''); }}>
          <IconArrowDown size={13} /> SELL
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 140 }}
          placeholder="Cari token (symbol / 0x)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), searchToken())}
        />
        <button type="button" className="btn" onClick={searchToken} disabled={searching}>{searching ? '…' : 'Cari'}</button>
      </div>

      {token && (
        <div style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <strong>{token.symbol} ({token.chainId})</strong>
          <span style={{ color: 'var(--accent)' }}>${token.priceUsd?.toFixed(6)}</span>
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
        onChange={(e) => { setAmount(e.target.value); setOk(''); }}
      />

      <button
        type="button"
        className="btn primary"
        style={{ width: '100%', minHeight: 40, fontWeight: 700 }}
        disabled={submitting || !token}
        onClick={createIntent}
      >
        {submitting ? 'Membuat intent…' : `Buat intent ${side.toUpperCase()}`}
      </button>

      {ok && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--up)', display: 'flex', gap: 6, alignItems: 'center' }}><IconCheck size={13} /> {ok}</div>}
      {err && <div className="error" style={{ marginTop: 12 }}><IconAlert size={13} /> {err}</div>}

      {openIntents.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <strong style={{ fontSize: 12 }}>Menunggu Approve ({openIntents.length})</strong>
          {approveError && <div className="error" style={{ marginTop: 8, fontSize: 11 }}>{approveError}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {openIntents.map((i) => (
              <div key={i.id} style={{ background: 'var(--panel-2)', borderRadius: 6, padding: 10, fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>
                  <strong style={{ color: i.side === 'buy' ? 'var(--up)' : 'var(--down)' }}>{i.side.toUpperCase()}</strong>
                  {' '}{i.symbol} · ${Number(i.amountUsd).toFixed(2)}
                  <span style={{ color: 'var(--muted)' }}>
                    {' · '}{i.side === 'buy' ? `bayar ${i.fundingToken === 'usdt' ? 'USDT' : 'native'}` : 'hasil ke USDT'}
                  </span>
                </span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn" style={{ fontSize: 11, minHeight: 28 }} disabled={approvingId !== null} onClick={() => cancelIntent(i)}>Batal</button>
                  <button type="button" className="btn primary" style={{ fontSize: 11, minHeight: 28 }} disabled={approvingId !== null} onClick={() => approveIntent(i)}>
                    {approvingId === i.id ? '…' : 'Approve'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
