// Single source of truth for the chain list every selector renders.
//
// The backend owns the set of chains it can execute on (CHAINS in
// evmWallet.js) and publishes it at /api/real/evm/chains. The UI used to keep
// four hand-written copies — RealTradePanel (7 chains), Watchlist / Chart /
// Overview (4 each) — so they drifted: the selectors were missing Optimism,
// Polygon and Avalanche while the executor accepted all three. Fetch it once
// and derive every list from the same answer.
//
// Module-level cache: this list is static for the life of a backend process,
// and several components mount at once, so a per-mount fetch would fire N
// identical requests on every navigation. The in-flight promise is cached too,
// so concurrent mounts share one request rather than racing.
import { useEffect, useMemo, useState } from 'react';
import { api, EvmChain } from '../api/client';

let cache: EvmChain[] | null = null;
let inFlight: Promise<EvmChain[]> | null = null;

/** Fetch the chain list once per page load; safe to call from many components. */
export function loadEvmChains(): Promise<EvmChain[]> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = api.evmChains()
    .then((r) => {
      const chains = r.chains ?? [];
      // Never cache an empty answer — a transient backend error would otherwise
      // leave every selector permanently blank for the rest of the session.
      if (chains.length > 0) cache = chains;
      return chains;
    })
    .catch(() => [] as EvmChain[])
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * The executable chain list, plus `keys` for membership tests.
 *
 * `chains` is empty until the first load resolves — callers that gate on
 * membership (e.g. "is this search result tradeable?") should treat empty as
 * "unknown" rather than "nothing is tradeable", or they will reject every
 * token during the first render.
 *
 * `keys` is memoised on `chains`. RealTradePanel/RealTradeForm keep `keys` in
 * a useCallback dependency list, and a fresh array on every render would
 * invalidate that callback on every render of the parent.
 */
export function useEvmChains(): { chains: EvmChain[]; keys: string[] } {
  const [chains, setChains] = useState<EvmChain[]>(() => cache ?? []);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    loadEvmChains().then((c) => { if (!cancelled) setChains(c); });
    return () => { cancelled = true; };
  }, []);

  const keys = useMemo(() => chains.map((c) => c.key), [chains]);
  return { chains, keys };
}
