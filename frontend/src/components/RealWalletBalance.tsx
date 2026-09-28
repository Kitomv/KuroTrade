// Compact on-chain balance summary for the global Real Wallet panel.
// Importers/callers: pages/Trade.tsx. Requires EvmWalletProvider.
// API/data: reads the bound address's balance from GET /api/real/portfolio.
// Data schema: in-memory <native:number, tokenCount:number>.
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvmWallet } from './EvmWalletContext';

export function RealWalletBalance() {
  const { connected, realMode } = useEvmWallet();
  const [native, setNative] = useState<number | null>(null);
  const [tokenCount, setTokenCount] = useState(0);

  useEffect(() => {
    if (!connected || !realMode) { setNative(null); setTokenCount(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.realPortfolio('base');
        if (cancelled) return;
        setNative(snap.native);
        setTokenCount(snap.holdings.length);
      } catch {
        // A missing bind or a dead RPC leaves the previous numbers in place —
        // the panel surfaces those states elsewhere.
      }
    })();
    return () => { cancelled = true; };
  }, [connected, realMode]);

  if (!connected || !realMode) return null;
  return (
    <div className="rwc-balance">
      <span><b>{native === null ? '…' : native.toFixed(4)}</b> ETH</span>
      <span><b>{tokenCount}</b> token</span>
    </div>
  );
}
