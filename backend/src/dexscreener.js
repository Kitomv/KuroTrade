// DexScreener REST client with TTL cache + single-flight dedup
// DexScreener has no price WebSocket — polling is required. Rate limit ~300 req/min.
// `ponytail:` swap for Bitquery/CoinGecko WebSocket when tick-level data is needed.

const BASE = 'https://api.dexscreener.com';
const TTL = 5_000; // ms (realtime 5s)
const MAX_CACHE_ENTRIES = 500; // hard cap: search queries vary endlessly, so the Map must be bounded

const cache = new Map(); // key -> { at, promise }

// `cacheKey` exists because one URL can serve several logical queries: the
// same wrapped-native address (0x4200…0006) is WETH on BOTH Base and Optimism,
// so keying on the URL alone made the second chain read the first chain's
// promise — a different asset's price under the same ticker.
function get(url, ttl = TTL, cacheKey = url) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = (async () => {
    // `ponytail:` hard timeout — without it a slow/rate-limited DexScreener
    // response hangs the backend handler and bars the browser's 6-connection
    // pool, freezing the UI after a few seconds.
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`DexScreener ${res.status}: ${url}`);
    return res.json();
  })();
  // Evict the oldest entry first so the cache can never exceed the cap.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { at: Date.now(), promise });
  promise.catch(() => cache.delete(cacheKey));
  return promise;
}

// Prune entries that expired without ever being read again (a one-off search
// query leaves its entry behind otherwise). unref'd so it never blocks exit.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > TTL) cache.delete(key);
  }
}, 60_000).unref?.();

// Normalize a DexScreener pair object into our shape
function normalize(pair) {
  const base = pair?.baseToken ?? {};
  const info = pair?.info ?? {};
  return {
    pairAddress: pair.pairAddress,
    chainId: pair.chainId,
    dexId: pair.dexId,
    url: pair.url,
    symbol: base.symbol,
    name: base.name,
    tokenAddress: base.address,
    icon: base.imageUrl ?? info?.imageUrl ?? null,
    priceUsd: parseFloat(pair.priceUsd ?? 0),
    priceNative: pair.priceNative,
    change24h: pair.priceChange?.h24 ?? 0,
    change5m: pair.priceChange?.m5 ?? 0,
    change1h: pair.priceChange?.h1 ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    fdv: pair.fdv ?? 0,
    txns24h: pair.txns?.h24 ?? { buys: 0, sells: 0 },
  };
}

export const dexscreener = {
  /** GET /token-profiles/latest/v1 — trending token profiles.
   *  Returns a bare array. Profiles carry no symbol/price, so enrich each
   *  with its market pair. Batched to stay well under the rate limit. */
  async tokenProfiles(limit = 30) {
    const data = await get(`${BASE}/token-profiles/latest/v1`, 60_000);
    const profiles = (Array.isArray(data) ? data : data.tokenProfiles ?? []).slice(0, limit);

    const enriched = await Promise.all(profiles.map(async (p) => {
      const market = await this.token(p.tokenAddress).catch(() => null);
      return {
        url: p.url,
        chainId: p.chainId,
        tokenAddress: p.tokenAddress,
        icon: p.icon,
        description: p.description,
        links: p.links,
        symbol: market?.symbol ?? null,
        name: market?.name ?? null,
        market,
      };
    }));
    return enriched;
  },

  /**
   * GET /latest/dex/tokens/{tokenAddress} — all pairs for a token.
   *
   * `chainId` picks the DEEPEST pair on that chain. The same ERC-20 (and the
   * same wrapped-native address) trades on several chains at genuinely
   * different prices, so taking `pairs[0]` — which DexScreener orders globally,
   * not per chain — returns another chain's price for this chain's asset.
   */
  async token(tokenAddress, chainId = null) {
    const data = await get(
      `${BASE}/latest/dex/tokens/${tokenAddress}`,
      TTL,
      `tok:${tokenAddress.toLowerCase()}:${chainId ?? '*'}`,
    );
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return null;
    const scoped = chainId ? pairs.filter((p) => p?.chainId === chainId) : pairs;
    const pool = scoped.length > 0 ? scoped : pairs;
    let best = pool[0];
    for (const p of pool) {
      if ((p?.liquidity?.usd ?? 0) > (best?.liquidity?.usd ?? 0)) best = p;
    }
    return normalize(best);
  },

  /** GET /latest/dex/search?q= — search tokens (optional custom ttl for stable queries) */
  async search(q, ttl = TTL) {
    const data = await get(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`, ttl);
    return (data.pairs ?? []).slice(0, 20).map(normalize);
  },

  /**
   * Batch token lookup — 1 HTTP call per 30 addresses.
   * GET /latest/dex/tokens/{addr1,addr2,...} returns pairs for all addresses.
   * Returns Map<tokenAddress, bestPair> (first pair per token, matching `token()`).
   */
  async tokens(addresses) {
    const uniq = [...new Set(addresses.map((a) => a?.toLowerCase()).filter(Boolean))];
    const result = new Map();
    if (uniq.length === 0) return result;
    for (let i = 0; i < uniq.length; i += 30) {
      const chunk = uniq.slice(i, i + 30);
      const data = await get(`${BASE}/latest/dex/tokens/${chunk.join(',')}`);
      const pairs = Array.isArray(data.pairs) ? data.pairs : [];
      const seen = new Set();
      for (const pair of pairs) {
        const addr = pair?.baseToken?.address;
        if (!addr) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue; // first pair per token (best liquidity)
        seen.add(key);
        result.set(key, normalize(pair));
      }
    }
    return result;
  },

  /** GET /latest/dex/pairs/{chainId}/{pairAddress} */
  async pair(chainId, pairAddress) {
    const data = await get(`${BASE}/latest/dex/pairs/${chainId}/${pairAddress}`);
    return normalize((data.pairs ?? [])[0] ?? {});
  },
};

// Native-coin pricing lives in evmWallet.js (getNativeUsdPrice), which resolves
// the wrapped-native token per chain by ADDRESS. This module stays a pure
// DexScreener client — no chain-specific pricing belongs here.