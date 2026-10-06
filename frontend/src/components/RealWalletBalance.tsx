// Compact on-chain balance summary for the global Real Wallet panel.
// Importers/callers: pages/Trade.tsx. Requires EvmWalletProvider.
// API/data: reads the bound address's USDT + native balance from
// GET /api/real/portfolio.
//
// This is a SECOND reader of the portfolio payload, so it shares the portfolio
// panel's rules:
//  - the USDT amount comes from the tested `usdtAmount` helper, which matches the
//    symbol case-insensitively AND treats a dropped holding as "unknown" rather
//    than zero (the backend silently drops non-zero holdings it cannot price);
//  - a failed load must replace the numbers with a failure, never leave stale
//    money on screen;
//  - a read is tagged with the chain + address it was fetched for, and
//    `currentSnapshot` rejects it during render when either has moved on — so no
//    committed frame shows one wallet's balances under another's label.
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvmWallet } from './EvmWalletContext';
import { chainKeyFromId, chainNameFromId, NATIVE_SYMBOL_BY_CHAIN } from '../lib/evm';
import { usdtAmount, currentSnapshot } from '../lib/walletView';
import type { BalanceSnapshot } from '../lib/walletView';

export function RealWalletBalance() {
  const { connected, realMode, chainId, address } = useEvmWallet();
  // Same chain resolution as RealWalletPortfolio. Null when the wallet is on a
  // chain the backend does not serve — the panel must say so rather than showing
  // another chain's numbers under the user's nose.
  const chain = chainKeyFromId(chainId);
  const [loaded, setLoaded] = useState<BalanceSnapshot | null>(null);

  useEffect(() => {
    // Drop the previous snapshot on every run so a re-fetch shows a loading
    // placeholder rather than last-known numbers.
    setLoaded(null);
    // `address` is a dependency: switching accounts on the SAME chain leaves
    // `chain` unchanged, so without it the effect would never re-run and the
    // previous wallet's balances would stay on screen.
    if (!connected || !realMode || !chain || !address) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.realPortfolio(chain);
        if (cancelled) return;
        setLoaded({
          chain,
          address,
          ok: true,
          native: data.native,
          // An absent USDT row is only a real zero when the backend dropped
          // nothing — otherwise the USDT could be among the unpriceable holdings.
          usdt: usdtAmount(data.holdings, data.unpricedCount),
        });
      } catch {
        // Surface the failure. Swallowing it left the previous chain's numbers
        // rendered as if they were this chain's.
        if (!cancelled) {
          setLoaded({ chain, address, ok: false, native: 0, usdt: null, err: 'Gagal memuat saldo' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [connected, realMode, chain, address]);

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

  // Only trust a snapshot fetched for THIS chain + address. Clearing state in the
  // effect runs after paint, so without this gate one committed frame would show
  // the previous wallet's balances under the new label.
  //
  // `address ?? ''` cannot match a stored blank: the effect returns early on
  // `!address`, so `loaded` is never written while `address` is null. Keep that
  // guard if you touch this — dropping it would let a blank tag compare equal.
  const cur = currentSnapshot(loaded, chain, address ?? '');
  if (cur && !cur.ok) {
    return (
      <div className="rwc-balance">
        <span style={{ color: 'var(--down)' }} role="alert">{cur.err}</span>
      </div>
    );
  }
  const native = cur ? cur.native : null;
  const usdt = cur ? cur.usdt : null;
  return (
    <div className="rwc-balance">
      <span><b>{usdt === null ? '…' : usdt.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> USDT</span>
      <span><b>{native === null ? '…' : native.toFixed(4)}</b> {NATIVE_SYMBOL_BY_CHAIN[chain] ?? 'ETH'}</span>
    </div>
  );
}
