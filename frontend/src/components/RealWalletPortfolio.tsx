// On-chain wallet detail for the Portfolio page, shown ONLY when real mode is
// on (the virtual ledger is hidden then — real funds are what matters).
// Balances come from the backend, which prices the bound address server-side;
// the swap dialog reuses RealTradeForm rather than reimplementing quote → sign.
// Importers/callers: Portfolio.tsx (when realMode).
// API/data: GET /api/real/portfolio; RealTradeForm for swaps.
//
// The panel answers one question first — how much real money is here — with a
// single balance-line figure, then breaks it into the two balances that make it
// up. It reads `nativeUsd` and prices the gas coin, which the previous version
// fetched and discarded.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { Modal } from './Modal';
import { RealTradeForm } from './RealTradeForm';
import { useEvmWallet } from './EvmWalletContext';
import { IconAlert, IconCheck, IconCopy, IconLock } from './Icons';
import { shortAddr, chainKeyFromId, chainNameFromId, NATIVE_SYMBOL_BY_CHAIN } from '../lib/evm';
import { fmt } from '../lib/format';
import {
  DISPLAY_SYMBOL, gasState, isReady, onChainTotalUsd, usdtAmount as usdtAmountOf, usdtRow,
  type GasState, type Holding,
} from '../lib/walletView';

/** Plain-language gas state, so the balance is legible without reading a colour. */
const GAS_TEXT: Record<GasState, string> = {
  ok: 'cukup untuk biaya gas',
  low: 'di bawah biaya gas — sisa untuk swap',
  empty: 'tidak ada untuk biaya gas',
  unknown: '…',
};

export function RealWalletPortfolio() {
  const { connected, isBound, address, chainId } = useEvmWallet();
  // Read the chain the wallet is ACTUALLY on, not a hardcoded default. Null
  // when the chain has no backend support — the panel then refuses to load
  // rather than showing Base balances as if they were the wallet's.
  const chain = chainKeyFromId(chainId);
  const nativeSymbol = chain ? (NATIVE_SYMBOL_BY_CHAIN[chain] ?? 'ETH') : 'ETH';
  const chainLabel = chainNameFromId(chainId) ?? chainId ?? 'tidak dikenal';

  const [native, setNative] = useState<number | null>(null);
  const [nativeUsd, setNativeUsd] = useState<number | null>(null);
  // The backend's sum over EVERY priced holding. The headline is called "Total
  // On-Chain", so it must include positions the panel does not tabulate — using
  // the USDT row alone would understate the wallet while calling it a total.
  const [tokenValueUsd, setTokenValueUsd] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  // Holdings the backend dropped before they ever reached us (decimals
  // unreadable). We cannot see them in `holdings`, so the count must come from
  // the payload — the client cannot guard against what it never receives.
  const [droppedHoldings, setDroppedHoldings] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  // Kept SEPARATE from `err` on purpose: `err` feeds the `ready` gate, and a
  // clipboard failure must never blank out balances that loaded fine. One shared
  // channel meant a denied clipboard permission reverted the whole panel to "…".
  const [copyErr, setCopyErr] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  // Only the newest load may write state. `load` is called from the effect AND
  // directly by Refresh / modal-close, so an effect-scoped flag would misfire;
  // a request id covers every caller. Without it, switching Base → Ethereum on
  // a slow connection lets the stale Base response overwrite the Ethereum one.
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    if (!connected || !address || !isBound || !chain) {
      setNative(null); setNativeUsd(null); setTokenValueUsd(null); setHoldings([]);
      setDroppedHoldings(0);
      setErr('');
      setCopyErr(''); // a stale clipboard notice must not outlive the wallet it names
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snap = await api.realPortfolio(chain);
      if (id !== reqId.current) return; // a newer load has superseded this one
      setNative(snap.native);
      setNativeUsd(snap.nativeUsd);
      setTokenValueUsd(snap.tokenValueUsd);
      setHoldings(snap.holdings);
      setDroppedHoldings(snap.unpricedCount ?? 0);
      setErr('');
      setCopyErr(''); // a fresh load clears a stale copy notice
    } catch (e: unknown) {
      if (id !== reqId.current) return;
      setErr(String((e as { message?: string })?.message ?? 'Gagal memuat saldo on-chain'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [connected, address, isBound, chain]);

  useEffect(() => { load(); }, [load]);

  const usdt = usdtRow(holdings);
  // The amount comes from the tested helper. An absent row is a real zero ONLY
  // when the backend dropped nothing: it silently drops non-zero holdings whose
  // decimals it cannot read, so when it dropped any the USDT may be among them
  // and the amount is unknown, not zero. The `ready` gate decides whether a
  // number may be shown at all; this decides what that number is.
  const usdtAmount = usdtAmountOf(holdings, droppedHoldings);
  // A known amount can still be un-valued (row present but priceUsd null); USDT
  // is the app's funding currency and a dollar by definition, so an unpriced row
  // still values at face — matching the backend's own USDT = $1 rule.
  const usdtValue = usdt ? (usdt.valueUsd ?? usdt.amount) : null;
  // Tokens the panel deliberately does not tabulate (the app is USDT-denominated)
  // — counted only so the headline never hides real money without saying so.
  const otherHoldings = holdings.filter((h) => h.symbol?.toLowerCase() !== DISPLAY_SYMBOL.toLowerCase());
  // A holding the backend could not price is skipped from `tokenValueUsd`, so a
  // total built from that sum would omit real money. Counted so the total can
  // refuse to be a number instead. USDT is exempt: it is a dollar by definition
  // (see `usdtValue`), so it is never "unpriced".
  const unpricedHoldings = useMemo(
    () => droppedHoldings + holdings.filter((h) => h.valueUsd === null && h.symbol?.toLowerCase() !== DISPLAY_SYMBOL.toLowerCase()).length,
    [holdings, droppedHoldings],
  );

  const total = onChainTotalUsd({ native, nativeUsd, tokenValueUsd, unpricedHoldings });
  const gas = gasState(native);
  // "Ready" means the balances are actually known — a failed load leaves
  // `loading` false with the initial empty balances still in place, so the gate
  // must reject an error too. Every state that is NOT ready shows "…" rather
  // than asserting "no USDT": we have not looked, which is not the same as zero.
  const ready = isReady({ loading, err, isBound, chain, address });
  // NaN passes `!== null` but renders as the literal text "NaN" in the row —
  // narrow to a finite number so this agrees with gasState. The `typeof` test
  // is what lets TypeScript narrow `native` for the render below.
  const nativeNum = ready && typeof native === 'number' && Number.isFinite(native) ? native : null;

  const copyAddress = async () => {
    if (!address) return;
    // Only claim success once the write resolves. A rejected write (insecure
    // origin, denied permission, no async clipboard API) previously still
    // flashed "Tersalin", and a user who trusts it pastes a stale address.
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setCopyErr('');
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // NOT setErr: that feeds the `ready` gate and would blank the balances.
      setCopyErr('Gagal menyalin alamat — browser menolak akses clipboard.');
    }
  };

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
    <div className="card" style={{ marginBottom: 24 }} aria-busy={loading}>
      <div className="wallet-head">
        <div className="wallet-head-title">
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

      {err && (
        <div style={{ padding: '14px 20px 0' }}>
          {/* role=alert so a real-money load failure is announced, not silent. */}
          <div className="error" role="alert"><IconAlert size={13} /> {err}</div>
        </div>
      )}
      {copyErr && (
        <div style={{ padding: '14px 20px 0' }}>
          {/* Its own channel: a clipboard failure must not touch the balances. */}
          <div className="error" role="alert" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'rgba(232, 163, 61, .4)' }}>
            <IconAlert size={13} /> {copyErr}
          </div>
        </div>
      )}
      {!isBound && (
        <div style={{ padding: '14px 20px 0' }}>
          <div className="error" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'rgba(232, 163, 61, .4)' }}>
            <IconLock size={13} /> Bind wallet dulu (panel Real Wallet di sidebar) sebelum swap dana asli.
          </div>
        </div>
      )}
      {chainId && !chain && isBound && (
        <div style={{ padding: '14px 20px 0' }}>
          <div className="error">
            <IconAlert size={13} /> Wallet kamu di {chainLabel}. Chain ini belum didukung backend —
            ganti ke Base di MetaMask untuk melihat saldo dan melakukan swap.
          </div>
        </div>
      )}

      {/* The balance line: an amber rule over the one number that matters. */}
      <div className="wallet-total">
        <div className="wallet-total-rule" />
        <div className="wallet-total-label">Total On-Chain</div>
        <div className="wallet-total-value" aria-live="polite">
          {ready ? fmt.usd(total) : '…'}
        </div>
        {ready && unpricedHoldings > 0 && (
          <p className="wallet-note" style={{ color: 'var(--accent)' }}>
            {unpricedHoldings} token di wallet ini belum punya harga — total di atas belum termasuk nilainya.
          </p>
        )}
        {ready && unpricedHoldings === 0 && total !== null && otherHoldings.length > 0 && (
          <p className="wallet-note">
            +{otherHoldings.length} token lain di wallet ini tidak ditampilkan (panel ini fokus USDT).
          </p>
        )}
      </div>

      <div className="wallet-balances">
        <div className="wallet-balance">
          <div className="wallet-balance-label">{nativeSymbol} · gas + trade</div>
          <div className="wallet-balance-value">{nativeNum === null ? '…' : nativeNum.toFixed(4)}</div>
          <div
            className="wallet-balance-sub"
            style={nativeNum !== null && (gas === 'low' || gas === 'empty') ? { color: 'var(--down)' } : undefined}
          >
            {nativeNum !== null && nativeUsd !== null ? `≈ ${fmt.usd(nativeNum * nativeUsd)} · ` : ''}
            {nativeNum !== null ? GAS_TEXT[gas] : GAS_TEXT.unknown}
          </div>
        </div>
        <div className="wallet-balance">
          <div className="wallet-balance-label">USDT · dana trading</div>
          <div className="wallet-balance-value">
            {ready && usdtAmount !== null ? usdtAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '…'}
          </div>
          <div className="wallet-balance-sub">
            {!ready
              ? GAS_TEXT.unknown
              : usdtAmount === null
                ? 'jumlah belum bisa dibaca — ada token tanpa harga'
                : !usdt
                  ? 'belum ada — kirim USDT ke alamat di bawah'
                  : `≈ ${fmt.usd(usdtValue)} · ${shortAddr(usdt.token, 4)}`}
          </div>
        </div>
      </div>

      <div className="wallet-foot">
        <span className="wallet-addr">
          {address ? shortAddr(address, 8) : '—'}
          {chainId && !chain && (
            <span style={{ color: 'var(--down)' }}> · chain {chainLabel} belum didukung — saldo tidak dimuat</span>
          )}
        </span>
        {address && (
          <button
            type="button"
            className="wallet-copy"
            onClick={copyAddress}
            aria-label={copied ? 'Alamat tersalin' : 'Salin alamat wallet'}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? 'Tersalin' : 'Salin alamat'}
          </button>
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
