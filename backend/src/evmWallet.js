// EVM execution layer — 1inch quote + unsigned tx builder. NO private keys.
// Importers/callers: server.js (/api/real/*), aiAgent.js (exposure/affordability).
// User instruction: "allin metamask pokoknya kalo real wallet yang lain hapus".
//
// The server never signs. It holds INCH_API_KEY (an aggregator key that must
// not ship in the browser bundle) and returns the unsigned tx that MetaMask
// signs via eth_sendTransaction. hotWallet.js's keystore and every execute*
// function were removed with that decision — they were the only code path that
// could move funds without a human click.

import { ethers } from 'ethers';
import { getBoundWallet } from './realIntent.js';
import { dexscreener } from './dexscreener.js';

// --- Chain config -----------------------------------------------------------
// Per-chain: rpc, 1inch endpoint, native symbol, explorer, gas reserve.
// Nothing else in the execution path is chain-specific, so adding a chain is
// one entry here.
//
// `gasReserveNative` is the native balance that must stay untouched for gas.
// It is per-chain because the same flat number is wrong everywhere: measured
// live, a 300k-gas swap costs 0.0000018 ETH on Base, 0.000014 BNB on BSC and
// 0.0015 AVAX on Avalanche. The old shared constant (0.005) was ~300x too
// large on cheap chains and too small on Avalanche — a wallet with 0.0000168
// BNB read as "cannot afford" while sitting on $7.70 of USDT.
//
// Each value covers an approve + swap (measured 280,819 gas on BSC) with
// headroom for a several-fold gas-price rise from today's level.
export const CHAINS = {
  base: {
    chainId: 8453,
    rpc: () => process.env.BACKEND_BASE_RPC || 'https://mainnet.base.org',
    native: 'ETH',
    explorer: 'https://basescan.org/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/8453',
    gasReserveNative: 0.00005,
  },
  ethereum: {
    chainId: 1,
    rpc: () => process.env.BACKEND_ETH_RPC || 'https://eth.llamarpc.com',
    native: 'ETH',
    explorer: 'https://etherscan.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/1',
    gasReserveNative: 0.0005,
  },
  arbitrum: {
    chainId: 42161,
    rpc: () => process.env.BACKEND_ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc',
    native: 'ETH',
    explorer: 'https://arbiscan.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/42161',
    gasReserveNative: 0.0001,
  },
  bsc: {
    chainId: 56,
    rpc: () => process.env.BACKEND_BSC_RPC || 'https://bsc-dataseed.bnbchain.org',
    native: 'BNB',
    explorer: 'https://bscscan.com/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/56',
    gasReserveNative: 0.0003,
  },
  optimism: {
    chainId: 10,
    rpc: () => process.env.BACKEND_OPTIMISM_RPC || 'https://mainnet.optimism.io',
    native: 'ETH',
    explorer: 'https://optimistic.etherscan.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/10',
    gasReserveNative: 0.00005,
  },
  polygon: {
    chainId: 137,
    rpc: () => process.env.BACKEND_POLYGON_RPC || 'https://polygon-rpc.com',
    native: 'POL',
    explorer: 'https://polygonscan.com/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/137',
    gasReserveNative: 0.02,
  },
  avalanche: {
    chainId: 43114,
    rpc: () => process.env.BACKEND_AVALANCHE_RPC || 'https://api.avax.network/ext/bc/C/rpc',
    native: 'AVAX',
    explorer: 'https://snowtrace.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/43114',
    gasReserveNative: 0.02,
  },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Canonical USDT contract per chain.
 *
 * Always tracked in the real portfolio: the position-derived token list only
 * contains what the autopilot traded, so a wallet funded with USDT (the usual
 * way to fund a trading wallet) showed an empty table and a total that ignored
 * the balance the user actually cares about.
 *
 * USDT is NOT the same address across chains — each is a separate deployment.
 */
export const USDT_BY_CHAIN = {
  base: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  arbitrum: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  bsc: '0x55d398326f99059fF775485246999027B3197955',
  optimism: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  polygon: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  avalanche: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
};

// Fail fast at boot on a malformed entry. This module loads with the server,
// and a typo here does not crash anything visible — it silently tracks the
// wrong contract, or (worse) mislabels and misprices a stranger's token as a
// stablecoin. ethers.getAddress throws on bad length, non-hex characters, or a
// broken EIP-55 checksum; the round-trip check additionally requires the stored
// literal to be the canonical checksummed form.
for (const [chain, addr] of Object.entries(USDT_BY_CHAIN)) {
  let normalized;
  try {
    normalized = ethers.getAddress(addr);
  } catch {
    throw new Error(`USDT_BY_CHAIN.${chain} bukan alamat valid: ${addr}`);
  }
  if (normalized !== addr) {
    throw new Error(`USDT_BY_CHAIN.${chain} checksum salah: ${addr} (harusnya ${normalized})`);
  }
}

/**
 * Symbol for a known contract ON A SPECIFIC CHAIN, so the table is not raw hex.
 *
 * Keyed by `chain:address`, never by address alone: contract addresses are
 * chain-local, so the Ethereum USDT address on Base is an unrelated contract
 * someone could deploy. Keyed by address alone it would be mislabelled USDT —
 * and, with the $1 fallback in getEvmTokenValue, valued as if it were real.
 */
const KNOWN_SYMBOLS = new Map(
  Object.entries(USDT_BY_CHAIN).map(([chain, addr]) => [`${chain}:${addr.toLowerCase()}`, 'USDT']),
);

/** Known symbol for `token` on `chain`, or null. Case-insensitive on the address. */
export function knownSymbol(chain, token) {
  return KNOWN_SYMBOLS.get(`${chain}:${String(token).toLowerCase()}`) ?? null;
}
const ZERO_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // 1inch native sentinel
const HEX_RE = /^0x[0-9a-fA-F]*$/;

/**
 * 1inch Aggregation Router v6.
 *
 * v6 is deployed at the SAME CREATE2 address on every supported chain, which
 * is why this is one constant and not a per-chain map. A per-chain map is how
 * an earlier draft silently shipped the v5 address
 * (0x1111111254EEB25477B68fb85Ed929f73A960582) for six chains.
 *
 * VERIFY against https://docs.1inch.io before the first real trade. This is a
 * security boundary and the failure mode is deliberately CLOSED: a wrong value
 * refuses every swap rather than approving an unknown contract. Override via
 * env if 1inch rotates the router.
 */
const ONE_INCH_ROUTER = String(
  process.env.ONE_INCH_ROUTER || '0x111111125421cA6dc452d289314280a0f8842A65',
).toLowerCase();

/** List supported EVM chains (drives the chain selector in the UI). */
export function listEvmChains() {
  return Object.entries(CHAINS).map(([key, cfg]) => ({
    key,
    chainId: cfg.chainId,
    native: cfg.native,
    explorer: cfg.explorer,
  }));
}

export function isSupportedChain(chain) {
  return Object.hasOwn(CHAINS, String(chain));
}

export function getChainConfig(chain = 'base') {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Chain "${chain}" tidak didukung`);
  return cfg;
}

/**
 * Native balance to keep untouched for gas on `chain`.
 *
 * Per-chain because one flat number is wrong on every chain (see the CHAINS
 * comment for the measurements). Unknown chains fall back to the legacy flat
 * constant, which stays exported so nothing that referenced it breaks.
 */
export function getGasReserve(chain = 'base') {
  return CHAINS[chain]?.gasReserveNative ?? EVM_FEE_RESERVE_NATIVE;
}

/**
 * RPC provider for `chain`.
 *
 * The network is declared up front (`new Network(name, chainId)` +
 * `staticNetwork: true`) rather than auto-detected. With auto-detection, an
 * unreachable endpoint makes ethers retry "failed to detect network" once a
 * second FOREVER — and every provider this module hands out is short-lived,
 * so a single dead RPC (eth.llamarpc.com and polygon-rpc.com both answer 401
 * from this machine) produced a permanent log flood that also burned CPU.
 * Declaring the network skips detection entirely: the call fails once and
 * that is the end of it.
 *
 * Callers MUST destroy() the provider when done — this returns a fresh
 * instance, not a shared one, so a leaked reference keeps its sockets open.
 */
export function getProvider(chain = 'base') {
  const cfg = getChainConfig(chain);
  const network = new ethers.Network(chain, cfg.chainId);
  return new ethers.JsonRpcProvider(cfg.rpc(), network, { staticNetwork: true });
}

/** The wallet this user bound for real trading (MetaMask address, or null). */
export function getBoundEvmAddress(userId) {
  return getBoundWallet(userId);
}

/**
 * Is this the router we are willing to hand an ERC-20 allowance to?
 *
 * The old executor trusted whatever `tx.to` came back in the 1inch payload and
 * approved it for MaxUint256, with no check at all. This is the choke point
 * that replaced it: the frontend must clear this before signing an approval,
 * and the amount approved is the exact swap size, never an unlimited grant.
 */
export function isAllowedRouter(address) {
  if (!ADDRESS_RE.test(String(address ?? ''))) return false;
  return String(address).toLowerCase() === ONE_INCH_ROUTER;
}

async function inchFetch(path, chain = 'base') {
  const cfg = getChainConfig(chain);
  const key = process.env.INCH_API_KEY || '';
  if (!key) throw new Error('INCH_API_KEY belum diset di .env — gratis di https://portal.1inch.dev');
  const res = await fetch(`${cfg.inch}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`1inch ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function assertAddress(value, label) {
  const v = String(value ?? '');
  if (!ADDRESS_RE.test(v)) throw new Error(`${label} harus alamat 0x + 40 hex`);
  return v;
}

function assertAtomicAmount(amount) {
  const amt = String(amount);
  if (!/^\d+$/.test(amt) || amt === '0') throw new Error('amount harus atomic units > 0');
  return amt;
}

function isNative(src) {
  return String(src).toLowerCase() === ZERO_ADDRESS;
}

/** Quote a swap. `amount` is atomic units of `src` (wei for native). */
export async function evmQuote({ src, dst, amount, chain = 'base' }) {
  assertAddress(src, 'src');
  assertAddress(dst, 'dst');
  const params = new URLSearchParams({
    src, dst, amount: assertAtomicAmount(amount), disableEstimate: 'true',
  });
  return inchFetch(`/quote?${params}`, chain);
}

/**
 * Normalize the `tx.value` field of a 1inch swap response to hex.
 *
 * 1inch v6 returns `value` as a DECIMAL string — `"1000000000000000"` for a
 * native swap, `"0"` for an ERC-20 one — while `eth_sendTransaction` wants hex.
 * The previous code fed the raw value straight into a hex regex, so every
 * build failed with "field tidak valid" (both native and ERC-20 paths: no
 * intent has ever reached 'done' through this function).
 *
 * Accepts: null/undefined (→ 0x0), a decimal string, a number, or an already
 * hex `0x…` string. Throws on anything else so a malformed upstream response
 * still fails loudly.
 */
export function normalizeTxValue(value) {
  if (value === null || value === undefined || value === '') return '0x0';
  const s = String(value).trim();
  if (HEX_RE.test(s)) return s;
  if (!/^\d+$/.test(s)) {
    throw new Error(`tx.value tidak valid: ${String(value).slice(0, 40)}`);
  }
  const n = BigInt(s);
  return `0x${n.toString(16)}`;
}

/**
 * Clamp a slippage value. 1inch v6 takes slippage IN PERCENT (verified live:
 * the API rejects >50 with SLIPPAGE_TOO_HIGH, and dstAmount is identical
 * across 0.1–5, so the scale is percent, not bps). The old code passed 100
 * intending "1%" — that is 100%, refused outright.
 */
export function clampSlippage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(50, Math.max(0.01, n));
}

/**
 * Build the UNSIGNED swap transaction for MetaMask to sign.
 *
 * This is the whole point of the refactor: the server asks 1inch what to do,
 * hands the calldata to the browser, and a human approves it in MetaMask.
 * Nothing here broadcasts and nothing here holds a key.
 *
 * `slippage` is PERCENT (1 = 1%), capped at 50 by the API.
 */
export async function buildSwapTx({ src, dst, amount, chain = 'base', from, slippage = 1 }) {
  assertAddress(src, 'src');
  assertAddress(dst, 'dst');
  assertAddress(from, 'from');
  const amt = assertAtomicAmount(amount);
  const slip = clampSlippage(slippage);
  const params = new URLSearchParams({
    src, dst, amount: amt, from, slippage: String(slip), disableEstimate: 'true',
  });
  const swapResp = await inchFetch(`/swap?${params}`, chain);
  const tx = swapResp?.tx;
  if (!tx?.to || !tx?.data) throw new Error('1inch tidak mengembalikan data transaksi swap');
  if (!HEX_RE.test(String(tx.data))) {
    throw new Error('1inch mengembalikan tx dengan field tidak valid');
  }
  const value = normalizeTxValue(tx.value);
  // The router is the one address we will ask the user to approve. Refuse to
  // hand back a tx aimed anywhere else — a spoofed aggregator response must
  // never become a MetaMask signature request.
  if (!isAllowedRouter(tx.to)) {
    throw new Error(`Router 1inch tidak dikenal — swap dibatalkan demi keamanan`);
  }
  return {
    chain,
    chainId: getChainConfig(chain).chainId,
    to: tx.to,
    data: tx.data,
    value,
    gas: tx.gas ? String(tx.gas) : null,
    // Frontend approves this router for exactly `amount` when src is an ERC-20.
    // Native swaps need no approval. `approveToken` is the ERC-20 whose
    // allowance is needed (= src), so the client never has to guess — for a
    // USDT-funded buy that is the USDT contract, not the traded token.
    needsApproval: !isNative(src),
    approveSpender: isNative(src) ? null : tx.to,
    approveAmount: isNative(src) ? null : amt,
    approveToken: isNative(src) ? null : src,
    slippagePercent: slip,
  };
}

// --- On-chain reads ---------------------------------------------------------

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const DECIMALS_TTL_MS = 3_600_000; // 1h — a token's decimals are immutable
// Token addresses come from user input and DexScreener search results, so an
// unbounded Map would retain every token ever priced for the life of the
// process. Capped with the same oldest-first eviction dexscreener.js uses.
const DECIMALS_CACHE_MAX = 500;
const decimalsCache = new Map(); // `${chain}:${token}` -> { at, decimals }

// Drop expired entries so a long-running backend does not hold onto tokens it
// will never price again. unref'd so it never blocks process exit.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of decimalsCache) {
    if (now - entry.at > DECIMALS_TTL_MS) decimalsCache.delete(key);
  }
}, 60_000).unref?.();

/**
 * ERC-20 decimals, resolved ON-CHAIN from the token contract itself.
 *
 * The contract is authoritative. An aggregator index routinely misses new
 * tokens, and guessing 9 for a 6-decimal token mis-sells by 1000x. Cached 1h.
 * Returns null when unresolvable; callers MUST refuse the sell rather than
 * guess — a wrong decimals value over-sells by 1000x or more.
 */
export async function resolveTokenDecimals(token, chain = 'base') {
  const addr = assertAddress(token, 'token');
  const key = `${chain}:${addr.toLowerCase()}`;
  const hit = decimalsCache.get(key);
  if (hit && Date.now() - hit.at < DECIMALS_TTL_MS) return hit.decimals;
  const provider = getProvider(chain);
  try {
    const contract = new ethers.Contract(addr, ERC20_ABI, provider);
    const decimals = Number(await contract.decimals());
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
      // Evict the oldest entry first so the cap is never exceeded.
      if (decimalsCache.size >= DECIMALS_CACHE_MAX) {
        const oldest = decimalsCache.keys().next().value;
        if (oldest !== undefined) decimalsCache.delete(oldest);
      }
      decimalsCache.set(key, { at: Date.now(), decimals });
      return decimals;
    }
  } catch {
    // non-contract address or RPC failure — both land here
  } finally {
    // Short-lived provider: without destroy() a failed endpoint keeps its
    // sockets and timers alive after the call has already given up.
    provider.destroy();
  }
  return null;
}

/** Native balance in wei. */
export async function getEvmBalance(address, chain = 'base') {
  const provider = getProvider(chain);
  try {
    return await provider.getBalance(assertAddress(address, 'address'));
  } finally {
    provider.destroy();
  }
}

/** Native balance in human units (ETH, not wei). */
export async function getEvmBalanceNative(address, chain = 'base') {
  return Number(ethers.formatEther(await getEvmBalance(address, chain)));
}

/** ERC-20 balance in atomic units, or null when the contract does not answer. */
export async function getEvmTokenBalance(address, token, chain = 'base') {
  const provider = getProvider(chain);
  try {
    const contract = new ethers.Contract(assertAddress(token, 'token'), ERC20_ABI, provider);
    return BigInt(await contract.balanceOf(assertAddress(address, 'address')));
  } catch {
    return null;
  } finally {
    provider.destroy();
  }
}

/**
 * USD value of the wallet's ERC-20 holdings ONLY, excluding the native coin.
 *
 * Returns two numbers because callers need different things:
 *  - `valueUsd`    — every holding, INCLUDING USDT. What the portfolio shows.
 *  - `exposureUsd` — positions at risk only, EXCLUDING USDT. What the
 *    autopilot's exposure gate reads.
 *
 * USDT is cash, not a position: it is the funding currency and the undeployed
 * part of the book. Counting it as exposure reports ~100% on a wallet funded
 * with USDT, which permanently blocks every new buy — the same failure the
 * native-coin exclusion exists to prevent. The native coin stays out of both.
 *
 * `tokens` is the set to value — the caller's tracked/held tokens.
 */
export async function getEvmTokenValue(address, chain = 'base', tokens = []) {
  const owner = assertAddress(address, 'address');
  // USDT always rides along: the tracked-position list only holds what the
  // autopilot traded, so a wallet funded with USDT showed an empty table.
  const always = USDT_BY_CHAIN[chain] ? [USDT_BY_CHAIN[chain]] : [];
  const all = [...new Set([...always, ...tokens])];
  if (all.length === 0) return { valueUsd: 0, exposureUsd: 0, holdings: [] };
  const markets = await dexscreener.tokens(all).catch(() => new Map());
  let total = 0;
  let exposure = 0;
  const holdings = [];
  for (const token of all) {
    const balance = await getEvmTokenBalance(owner, token, chain);
    if (balance === null || balance === 0n) continue;
    const decimals = await resolveTokenDecimals(token, chain);
    if (decimals === null) continue;
    const amount = Number(ethers.formatUnits(balance, decimals));
    const norm = markets.get(String(token).toLowerCase());
    const symbol = knownSymbol(chain, token);
    // A stablecoin is a dollar even when DexScreener has no pair for it — but
    // only when the contract is THIS chain's known USDT (symbol is chain-scoped).
    const priceUsd = norm && norm.chainId === chain && Number(norm.priceUsd) > 0
      ? Number(norm.priceUsd)
      : (symbol === 'USDT' ? 1 : null);
    const valueUsd = priceUsd !== null ? Math.round(amount * priceUsd * 100) / 100 : null;
    if (valueUsd !== null) total += valueUsd;
    holdings.push({
      token,
      symbol,
      amount,
      decimals,
      priceUsd,
      valueUsd,
    });
    if (symbol !== 'USDT' && valueUsd !== null) exposure += valueUsd;
  }
  return {
    valueUsd: Math.round(total * 100) / 100,
    exposureUsd: Math.round(exposure * 100) / 100,
    holdings,
  };
}

/** Total on-chain USD value: native coin + priced ERC-20 holdings. */
export async function getEvmTotalValue(address, chain = 'base', { nativeUsd = null, tokens = [] } = {}) {
  const price = Number(nativeUsd) > 0 ? Number(nativeUsd) : await getNativeUsdPrice(chain);
  if (!price) return null;
  const nativeHuman = await getEvmBalanceNative(address, chain);
  const { valueUsd } = await getEvmTokenValue(address, chain, tokens);
  return Math.round((nativeHuman * price + valueUsd) * 100) / 100;
}

// --- Multi-chain portfolio --------------------------------------------------

/**
 * Group a position list into { chain: [tokenAddress] }.
 *
 * An address is only meaningful on the chain the position was opened on —
 * contracts are chain-local, so valuing a BSC token through the Base RPC reads
 * a stranger's contract (or reverts). A position without a chainId is legacy;
 * wallet.js defaults those to base, and valuation must read the same chain
 * they were recorded on. A position on a chain we do not support is DROPPED:
 * there is no RPC that could read it, and guessing another chain would
 * misvalue it.
 */
export function groupTokensByChain(positions = []) {
  const out = {};
  for (const p of positions ?? []) {
    const addr = typeof p?.tokenAddress === 'string' ? p.tokenAddress : null;
    if (!addr) continue;
    const chain = p.chainId == null ? 'base' : String(p.chainId);
    if (!isSupportedChain(chain)) continue;
    (out[chain] ??= []).push(addr);
  }
  return out;
}

const PORTFOLIO_CACHE_TTL_MS = 60_000;
const portfolioCache = new Map(); // cacheKey -> { at, value }

/** Reject after `ms`, so one dead endpoint cannot stall the autopilot tick. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout setelah ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function portfolioCacheKey(owner, tokensByChain) {
  const parts = Object.keys(tokensByChain).sort().map(
    (c) => `${c}:${[...tokensByChain[c]].map((a) => String(a).toLowerCase()).sort().join(',')}`,
  );
  return `${owner.toLowerCase()}|${parts.join('|')}`;
}

/** Native balance in human units, with the provider destroyed afterwards. */
async function nativeBalanceHuman(address, chain, timeoutMs) {
  const provider = getProvider(chain);
  try {
    const wei = await withTimeout(provider.getBalance(address), timeoutMs);
    return Number(ethers.formatEther(wei));
  } finally {
    // A failed call leaves ethers retrying network detection in the background
    // once a second, forever. destroy() is what stops that loop.
    provider.destroy();
  }
}

/**
 * Wallet value across EVERY supported chain, in USD.
 *
 * The autopilot's balance gates used to read `base` only, so a wallet funded
 * on BSC (or any other chain) read as $0 and the scout stopped with
 * "Nilai wallet $0.00 < $5" while the money sat on a chain the gate never
 * looked at. This sweeps every supported chain instead.
 *
 * Returns { totalUsd, exposureUsd, perChain, pricedChains }:
 *  - totalUsd    native + ERC-20 (USDT included), summed over chains
 *  - exposureUsd positions at risk only — USDT and the native coin are cash,
 *                not exposure (see getEvmTokenValue for the full rationale)
 *  - perChain    per-chain breakdown, for diagnostics
 *
 * Cached for a minute: the autopilot tick runs every 5s per user and a 7-chain
 * RPC sweep per tick would hammer public endpoints. Chains that fail (dead
 * RPC, timeout) are skipped; an all-failed result is NOT cached, so a
 * transient outage retries on the next call instead of freezing a false zero.
 */
export async function getEvmPortfolioValue(address, { tokensByChain = {}, timeoutMs = 6_000 } = {}) {
  const owner = assertAddress(address, 'address');
  const key = portfolioCacheKey(owner, tokensByChain);
  const hit = portfolioCache.get(key);
  if (hit && Date.now() - hit.at < PORTFOLIO_CACHE_TTL_MS) return hit.value;

  const perChain = {};
  let totalUsd = 0;
  let exposureUsd = 0;
  await Promise.all(Object.keys(CHAINS).map(async (chain) => {
    const tokens = tokensByChain[chain] ?? [];
    try {
      // The native leg throws when the chain cannot be read at all — that is
      // the signal to skip the whole chain (including its token calls, which
      // would otherwise create more doomed providers).
      const nativeHuman = await nativeBalanceHuman(owner, chain, timeoutMs);
      const nativePrice = await getNativeUsdPrice(chain).catch(() => null);
      const nativeUsd = nativePrice ? nativeHuman * nativePrice : 0;
      // Token leg is best-effort even on a live chain: a chain with an
      // unpriceable native coin still contributes its token value.
      const tokenPart = await withTimeout(
        getEvmTokenValue(owner, chain, tokens), timeoutMs,
      ).catch(() => ({ valueUsd: 0, exposureUsd: 0, holdings: [] }));
      perChain[chain] = {
        nativeUsd: Math.round(nativeUsd * 100) / 100,
        valueUsd: Math.round((nativeUsd + tokenPart.valueUsd) * 100) / 100,
        exposureUsd: tokenPart.exposureUsd,
      };
      totalUsd += nativeUsd + tokenPart.valueUsd;
      exposureUsd += tokenPart.exposureUsd;
    } catch {
      // Chain unavailable — skipped, never fatal.
    }
  }));

  const value = {
    totalUsd: Math.round(totalUsd * 100) / 100,
    exposureUsd: Math.round(exposureUsd * 100) / 100,
    perChain,
    pricedChains: Object.keys(perChain).length,
  };
  if (value.pricedChains > 0) {
    if (portfolioCache.size >= 200) {
      const oldest = portfolioCache.keys().next().value;
      if (oldest !== undefined) portfolioCache.delete(oldest);
    }
    portfolioCache.set(key, { at: Date.now(), value });
  }
  return value;
}

// --- Pricing ---------------------------------------------------------------

const nativePriceCache = new Map(); // chain -> { at, price }

/**
 * Canonical wrapped-native token per chain (WETH/WBNB/WPOL/WAVAX).
 *
 * This exists because a TEXT search for "ETH" does not surface Base pairs at
 * all — DexScreener's search returns Ethereum/BSC/Starknet and zero Base rows,
 * so the native price resolved to null on the chain the app actually trades.
 * An address lookup is exact and chain-pinned, which is what a price oracle
 * for a specific chain needs.
 */
const WRAPPED_NATIVE = {
  base: '0x4200000000000000000000000000000000000006',       // WETH
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',   // WETH
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',   // WETH
  optimism: '0x4200000000000000000000000000000000000006',   // WETH
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',        // WBNB
  polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',   // WPOL
  avalanche: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
};

/**
 * Native-coin USD price for `chain`, via DexScreener.
 *
 * Returns null when unknown, and the caller MUST refuse rather than guess.
 * That matters more than it looks: `/latest/dex/tokens/{addr}` returns a
 * TRUNCATED set of pairs (30, ordered by an opaque ranking), so a chain can be
 * absent from the response even though its pool exists — Optimism never
 * appears for WETH, for instance. Those chains simply price as unknown and
 * their buys are blocked, which is the honest outcome: the alternative is
 * converting a USD budget into native units at another chain's rate.
 */
export async function getNativeUsdPrice(chain = 'base') {
  const hit = nativePriceCache.get(chain);
  if (hit && Date.now() - hit.at < 15_000) return hit.price;
  const wrapped = WRAPPED_NATIVE[chain];
  if (!wrapped) return null;
  try {
    const market = await dexscreener.token(wrapped, chain);
    if (market && market.chainId === chain && Number(market.priceUsd) > 0) {
      const price = Number(market.priceUsd);
      nativePriceCache.set(chain, { at: Date.now(), price });
      return price;
    }
  } catch {}
  return null;
}

// --- Risk guards ------------------------------------------------------------

/**
 * Native coin that must stay UNSPENT so the exit swap can still pay its own
 * gas. A wallet that spends its last wei on the entry swap can never sell —
 * the position becomes a stuck bag.
 *
 * LEGACY fallback only: per-chain reserves live in CHAINS.gasReserveNative and
 * are read through getGasReserve(). Kept exported because it is referenced by
 * comments and older call sites; new code should use getGasReserve(chain).
 */
export const EVM_FEE_RESERVE_NATIVE = 0.005;

/** Hard ceiling per trade; env-overridable like HOT_WALLET_MAX_USD_PER_TRADE. */
const DEFAULT_MAX_USD_PER_TRADE = 50;
export function checkTradeSize(usdAmount) {
  const cap = Number(process.env.HOT_WALLET_MAX_USD_PER_TRADE) || DEFAULT_MAX_USD_PER_TRADE;
  const val = Number(usdAmount);
  if (!Number.isFinite(val) || val <= 0) return { ok: false, cap, reason: 'usdAmount tidak valid' };
  if (val > cap) return { ok: false, cap, reason: `Melebihi batas maksimal $${cap} USD per transaksi` };
  return { ok: true, cap };
}

/**
 * Can the wallet actually pay for a BUY of `usdAmount` on `chain` with its
 * NATIVE coin and still keep a gas reserve for the eventual exit?
 *
 * The paper ledger says "plenty"; the MetaMask balance is the only real number.
 * The reserve is per-chain (getGasReserve) — the flat legacy constant was
 * ~300x too large on cheap chains.
 * Returns { ok, balanceNative, buyUsd, reserveNative, reason }.
 */
export async function checkEvmAffordability(address, usdAmount, { nativeUsd = null, chain = 'base' } = {}) {
  const reserve = getGasReserve(chain);
  const price = Number(nativeUsd) > 0 ? Number(nativeUsd) : await getNativeUsdPrice(chain);
  const balanceNative = await getEvmBalanceNative(address, chain).catch(() => null);
  if (balanceNative === null) {
    return { ok: false, balanceNative: 0, buyUsd: 0, reserveNative: reserve, reason: 'NO_BALANCE' };
  }
  if (!price) {
    return { ok: false, balanceNative, buyUsd: 0, reserveNative: reserve, reason: 'NO_PRICE' };
  }
  const wanted = Number(usdAmount);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { ok: false, balanceNative, buyUsd: 0, reserveNative: reserve, reason: 'BAD_AMOUNT' };
  }
  const spendableUsd = Math.max(0, balanceNative - reserve) * price;
  if (spendableUsd <= 0) {
    return { ok: false, balanceNative, buyUsd: 0, reserveNative: reserve, reason: 'NO_SPENDABLE' };
  }
  if (wanted > spendableUsd) {
    return { ok: false, balanceNative, buyUsd: spendableUsd, reserveNative: reserve, reason: 'LOW_BALANCE' };
  }
  return { ok: true, balanceNative, buyUsd: wanted, reserveNative: reserve, reason: 'OK' };
}

/**
 * Pure funding decision: which asset should pay for a buy of `usdAmount`?
 *
 * USDT first — it is the app's funding currency and the reason a wallet can
 * hold $7.70 of value and still read as unable to trade. Native gas must
 * survive either way, so USDT only wins when the native reserve is intact.
 *
 * `usdtBalance` is in USDT units (BSC uses 18 decimals, others 6 — the caller
 * converts; this function compares human units). `nativeBalance` is native.
 * Kept pure so the decision is unit-testable without any RPC.
 */
export function decideBuyFunding({ usdAmount, usdtBalance, nativeBalance, nativeUsdPrice, gasReserve }) {
  const wanted = Number(usdAmount);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { funding: null, reason: 'BAD_AMOUNT' };
  }
  const gasOk = Number.isFinite(nativeBalance) && nativeBalance >= gasReserve;
  // USDT leg: the balance must cover the buy, and gas must still be payable.
  if (usdtBalance !== null && usdtBalance !== undefined && Number(usdtBalance) >= wanted && gasOk) {
    return { funding: 'usdt', reason: 'OK' };
  }
  // Native leg: balance must cover the buy AND the reserve on top.
  const price = Number(nativeUsdPrice);
  if (Number.isFinite(price) && price > 0) {
    const spendableUsd = Math.max(0, (Number(nativeBalance) || 0) - gasReserve) * price;
    if (spendableUsd >= wanted) return { funding: 'native', reason: 'OK' };
    return {
      funding: null,
      reason: usdtBalance === null || usdtBalance === undefined ? 'NO_USDT_ON_CHAIN' : 'INSUFFICIENT',
    };
  }
  // No native price → cannot size a native buy, but a USDT buy does not need
  // one. If USDT covers it and gas is fine, still prefer that.
  if (usdtBalance !== null && usdtBalance !== undefined && Number(usdtBalance) >= wanted && gasOk) {
    return { funding: 'usdt', reason: 'OK' };
  }
  return { funding: null, reason: 'NO_NATIVE_PRICE' };
}

/**
 * Which asset pays for a buy on `chain`, reading live balances.
 *
 * Returns { funding: 'usdt'|'native'|null, usdtBalance, nativeBalance,
 * gasReserve, reason }. `usdtBalance` is null when the chain has no known
 * USDT or the read failed — the caller must NOT treat that as zero.
 */
export async function pickBuyFunding(address, usdAmount, chain = 'base') {
  const gasReserve = getGasReserve(chain);
  const [nativeBalance, usdtBalance] = await Promise.all([
    getEvmBalanceNative(address, chain).catch(() => null),
    (async () => {
      const usdt = USDT_BY_CHAIN[chain];
      if (!usdt) return null;
      const atomic = await getEvmTokenBalance(address, usdt, chain).catch(() => null);
      if (atomic === null) return null;
      const decimals = await resolveTokenDecimals(usdt, chain).catch(() => null);
      if (decimals === null) return null;
      return Number(ethers.formatUnits(atomic, decimals));
    })(),
  ]);
  const nativeUsdPrice = await getNativeUsdPrice(chain).catch(() => null);
  const decision = decideBuyFunding({
    usdAmount,
    usdtBalance,
    nativeBalance: nativeBalance === null ? NaN : nativeBalance,
    nativeUsdPrice,
    gasReserve,
  });
  return { ...decision, usdtBalance, nativeBalance, gasReserve };
}

// --- Intent → swap parameters -----------------------------------------------

/**
 * The swap legs for a stored intent, as a PURE decision.
 *
 * Buy: funding 'usdt' pays with the chain's USDT contract (amount = the USD
 * budget at $1, decimals resolved by the caller), 'native' pays with the
 * chain's coin (amount = the intent's precomputed amountWei). Absent
 * `fundingToken` on an old intent means 'native'.
 *
 * Sell: target USDT when the chain has one, so proceeds return to the funding
 * currency. A token whose address IS that chain's USDT falls back to native —
 * a USDT→USDT swap is invalid and 1inch would reject it.
 *
 * Returns { src, dst, amountKind } where amountKind tells the caller how to
 * resolve the atomic amount ('nativeWei' | 'usd' | 'tokenUnits'), keeping the
 * on-chain decimals read out of this pure function.
 */
export function resolveSwapParams(intent, chain, usdtByChain = USDT_BY_CHAIN) {
  const NATIVE = ZERO_ADDRESS;
  const usdt = usdtByChain[chain] ?? null;
  if (intent.side === 'buy') {
    const funding = intent.fundingToken ?? 'native';
    if (funding === 'usdt') {
      if (!usdt) throw new Error(`Chain "${chain}" tidak punya USDT — funding USDT tidak mungkin`);
      return { src: usdt, dst: intent.tokenAddress, amountKind: 'usd' };
    }
    return { src: NATIVE, dst: intent.tokenAddress, amountKind: 'nativeWei' };
  }
  // sell
  const dst = usdt && String(intent.tokenAddress).toLowerCase() !== usdt.toLowerCase()
    ? usdt
    : NATIVE;
  return { src: intent.tokenAddress, dst, amountKind: 'tokenUnits' };
}
