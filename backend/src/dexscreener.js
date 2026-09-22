// DexScreener REST client with TTL cache + single-flight dedup
// DexScreener has no price WebSocket — polling is required. Rate limit ~300 req/min.
// `ponytail:` swap for Bitquery/CoinGecko WebSocket when tick-level data is needed.

const BASE = 'https://api.dexscreener.com';
const TTL = 5_000; // ms (realtime 5s)
const MAX_CACHE_ENTRIES = 500; // hard cap: search queries vary endlessly, so the Map must be bounded

const cache = new Map(); // key -> { at, promise }

function get(url, ttl = TTL) {
  const hit = cache.get(url);
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
  cache.set(url, { at: Date.now(), promise });
  promise.catch(() => cache.delete(url));
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

  /** GET /latest/dex/tokens/{tokenAddress} — all pairs for a token, best pair normalized */
  async token(tokenAddress) {
    const data = await get(`${BASE}/latest/dex/tokens/${tokenAddress}`);
    const pair = (data.pairs ?? [])[0];
    if (!pair) return null;
    return normalize(pair);
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

/**
 * SOL/USD spot price for USD→lamports conversion (audit fix C1: BUY intents
 * must spend a SOL amount, not misread a USDC budget as SOL). Cached 15s;
 * falls back to a 'SOL' search if the wrapped-SOL mint lookup fails.
 * Returns null when unavailable — callers MUST refuse to emit a buy intent.
 */
let solUsdCache = { at: 0, price: null };
export async function getSolUsdPrice() {
  const now = Date.now();
  if (solUsdCache.price && now - solUsdCache.at < 15_000) return solUsdCache.price;
  let price = null;
  try {
    const token = await dexscreener.token('So11111111111111111111111111111111111111112');
    if (token && Number(token.priceUsd) > 0) price = Number(token.priceUsd);
  } catch {}
  if (price === null) {
    try {
      const results = await dexscreener.search('SOL', 60_000);
      const best = results
        .filter((r) => r.chainId === 'solana' && Number(r.priceUsd) > 0 && Number(r.liquidityUsd) > 1_000_000)
        .sort((a, b) => Number(b.liquidityUsd) - Number(a.liquidityUsd))[0];
      if (best) price = Number(best.priceUsd);
    } catch {}
  }
  if (price !== null) solUsdCache = { at: Date.now(), price };
  return price;
}