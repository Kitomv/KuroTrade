// Compact on-chain balance summary for the global Real Wallet panel.
// Importers/callers: pages/Trade.tsx. Requires EvmWalletProvider.
// API/data: reads the bound address's USDT balance from GET /api/real/portfolio.
// Data schema: in-memory <native:number, usdt:number>.
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvmWallet } from './EvmWalletContext';
import { chainKeyFromId, chainNameFromId, NATIVE_SYMBOL_BY_CHAIN } from '../lib/evm';

export function RealWalletBalance() {
  const { connected, realMode, chainId } = useEvmWallet();
  // Same chain resolution as RealWalletPortfolio. Null when the wallet is on a
  // chain the backend does not serve — the panel must say so rather than
  // showing Base numbers under the user's nose.
  const chain = chainKeyFromId(chainId);
  const [native, setNative] = useState<number | null>(null);
  const [usdt, setUsdt] = useState<number | null>(null);

  useEffect(() => {
    if (!connected || !realMode || !chain) { setNative(null); setUsdt(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.realPortfolio(chain);
        if (cancelled) return;
        setNative(snap.native);
        // Backend skips zero-balance holdings, so USDT is 0 — not unknown —
        // when it is absent from the list.
        setUsdt(snap.holdings.find((h) => h.symbol === 'USDT')?.amount ?? 0);
      } catch {
        // A missing bind or a dead RPC leaves the previous numbers in place —
        // the panel surfaces those states elsewhere.
      }
    })();
    return () => { cancelled = true; };
  }, [connected, realMode, chain]);

  if (!connected || !realMode) return null;
  if (!chain) {
    // chainId not read yet → transient, show a placeholder; chainId known but
    // unmapped → the wallet is on a chain the backend does not serve.
    if (!chainId) {
      return <div className="rwc-balance"><span>…</span></div>;
    }
    const label = chainNameFromId(chainId) ?? `chain ${chainId}`;
    return (
      <div className="rwc-balance">
        <span style={{ color: 'var(--down)' }}>Chain {label} belum didukung</span>
      </div>
    );
  }
  return (
    <div className="rwc-balance">
      <span><b>{usdt === null ? '…' : usdt.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> USDT</span>
      <span><b>{native === null ? '…' : native.toFixed(4)}</b> {NATIVE_SYMBOL_BY_CHAIN[chain] ?? 'ETH'}</span>
    </div>
  );
}
