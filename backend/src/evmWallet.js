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
// Per-chain: rpc, 1inch endpoint, native symbol, explorer. Nothing else in the
// execution path is chain-specific, so adding a chain is one entry here.
export const CHAINS = {
  base: {
    chainId: 8453,
    rpc: () => process.env.BACKEND_BASE_RPC || 'https://mainnet.base.org',
    native: 'ETH',
    explorer: 'https://basescan.org/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/8453',
  },
  ethereum: {
    chainId: 1,
    rpc: () => process.env.BACKEND_ETH_RPC || 'https://eth.llamarpc.com',
    native: 'ETH',
    explorer: 'https://etherscan.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/1',
  },
  arbitrum: {
    chainId: 42161,
    rpc: () => process.env.BACKEND_ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc',
    native: 'ETH',
    explorer: 'https://arbiscan.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/42161',
  },
  bsc: {
    chainId: 56,
    rpc: () => process.env.BACKEND_BSC_RPC || 'https://bsc-dataseed.bnbchain.org',
    native: 'BNB',
    explorer: 'https://bscscan.com/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/56',
  },
  optimism: {
    chainId: 10,
    rpc: () => process.env.BACKEND_OPTIMISM_RPC || 'https://mainnet.optimism.io',
    native: 'ETH',
    explorer: 'https://optimistic.etherscan.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/10',
  },
  polygon: {
    chainId: 137,
    rpc: () => process.env.BACKEND_POLYGON_RPC || 'https://polygon-rpc.com',
    native: 'POL',
    explorer: 'https://polygonscan.com/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/137',
  },
  avalanche: {
    chainId: 43114,
    rpc: () => process.env.BACKEND_AVALANCHE_RPC || 'https://api.avax.network/ext/bc/C/rpc',
    native: 'AVAX',
    explorer: 'https://snowtrace.io/tx/',
    inch: 'https://api.1inch.dev/swap/v6.0/43114',
  },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
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

export function getProvider(chain = 'base') {
  return new ethers.JsonRpcProvider(getChainConfig(chain).rpc());
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
 * Build the UNSIGNED swap transaction for MetaMask to sign.
 *
 * This is the whole point of the refactor: the server asks 1inch what to do,
 * hands the calldata to the browser, and a human approves it in MetaMask.
 * Nothing here broadcasts and nothing here holds a key.
 */
export async function buildSwapTx({ src, dst, amount, chain = 'base', from, slippage = 100 }) {
  assertAddress(src, 'src');
  assertAddress(dst, 'dst');
  assertAddress(from, 'from');
  const amt = assertAtomicAmount(amount);
  const slip = Math.min(500, Math.max(1, Math.floor(Number(slippage) || 100)));
  const params = new URLSearchParams({
    src, dst, amount: amt, from, slippage: String(slip), disableEstimate: 'true',
  });
  const swapResp = await inchFetch(`/swap?${params}`, chain);
  const tx = swapResp?.tx;
  if (!tx?.to || !tx?.data) throw new Error('1inch tidak mengembalikan data transaksi swap');
  if (!HEX_RE.test(String(tx.data)) || !HEX_RE.test(String(tx.value ?? '0x0'))) {
    throw new Error('1inch mengembalikan tx dengan field tidak valid');
  }
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
    value: String(tx.value ?? '0x0'),
    gas: tx.gas ? String(tx.gas) : null,
    // Frontend approves this router for exactly `amount` when src is an ERC-20.
    // Native swaps need no approval.
    needsApproval: !isNative(src),
    approveSpender: isNative(src) ? null : tx.to,
    approveAmount: isNative(src) ? null : amt,
    slippageBps: slip,
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
  try {
    const contract = new ethers.Contract(addr, ERC20_ABI, getProvider(chain));
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
  }
  return null;
}

/** Native balance in wei. */
export async function getEvmBalance(address, chain = 'base') {
  return getProvider(chain).getBalance(assertAddress(address, 'address'));
}

/** Native balance in human units (ETH, not wei). */
export async function getEvmBalanceNative(address, chain = 'base') {
  return Number(ethers.formatEther(await getEvmBalance(address, chain)));
}

/** ERC-20 balance in atomic units, or null when the contract does not answer. */
export async function getEvmTokenBalance(address, token, chain = 'base') {
  try {
    const contract = new ethers.Contract(assertAddress(token, 'token'), ERC20_ABI, getProvider(chain));
    return BigInt(await contract.balanceOf(assertAddress(address, 'address')));
  } catch {
    return null;
  }
}

/**
 * USD value of the wallet's ERC-20 holdings ONLY, excluding the native coin.
 *
 * Exposure is the risky part of a book: the ETH in the wallet is undeployed
 * cash and gas, not a position at risk. Counting it reports ~100% exposure on
 * a wallet holding nothing but ETH, which permanently blocks every new buy.
 *
 * `tokens` is the set to value — the caller's tracked/held tokens.
 */
export async function getEvmTokenValue(address, chain = 'base', tokens = []) {
  const owner = assertAddress(address, 'address');
  if (tokens.length === 0) return { valueUsd: 0, holdings: [] };
  const markets = await dexscreener.tokens(tokens).catch(() => new Map());
  let total = 0;
  const holdings = [];
  for (const token of tokens) {
    const balance = await getEvmTokenBalance(owner, token, chain);
    if (balance === null || balance === 0n) continue;
    const decimals = await resolveTokenDecimals(token, chain);
    if (decimals === null) continue;
    const amount = Number(ethers.formatUnits(balance, decimals));
    const norm = markets.get(String(token).toLowerCase());
    const priceUsd = norm && norm.chainId === chain && Number(norm.priceUsd) > 0
      ? Number(norm.priceUsd)
      : null;
    const valueUsd = priceUsd !== null ? Math.round(amount * priceUsd * 100) / 100 : null;
    if (valueUsd !== null) total += valueUsd;
    holdings.push({ token, amount, decimals, priceUsd, valueUsd });
  }
  return { valueUsd: Math.round(total * 100) / 100, holdings };
}

/** Total on-chain USD value: native coin + priced ERC-20 holdings. */
export async function getEvmTotalValue(address, chain = 'base', { nativeUsd = null, tokens = [] } = {}) {
  const price = Number(nativeUsd) > 0 ? Number(nativeUsd) : await getNativeUsdPrice(chain);
  if (!price) return null;
  const nativeHuman = await getEvmBalanceNative(address, chain);
  const { valueUsd } = await getEvmTokenValue(address, chain, tokens);
  return Math.round((nativeHuman * price + valueUsd) * 100) / 100;
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
 * Can the wallet actually pay for a BUY of `usdAmount` on `chain` and still
 * keep a gas reserve for the eventual exit?
 *
 * The paper ledger says "plenty"; the MetaMask balance is the only real number.
 * Returns { ok, balanceNative, buyUsd, reserveNative, reason }.
 */
export async function checkEvmAffordability(address, usdAmount, { nativeUsd = null, chain = 'base' } = {}) {
  const price = Number(nativeUsd) > 0 ? Number(nativeUsd) : await getNativeUsdPrice(chain);
  const balanceNative = await getEvmBalanceNative(address, chain).catch(() => null);
  if (balanceNative === null) {
    return { ok: false, balanceNative: 0, buyUsd: 0, reserveNative: EVM_FEE_RESERVE_NATIVE, reason: 'NO_BALANCE' };
  }
  if (!price) {
    return { ok: false, balanceNative, buyUsd: 0, reserveNative: EVM_FEE_RESERVE_NATIVE, reason: 'NO_PRICE' };
  }
  const wanted = Number(usdAmount);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { ok: false, balanceNative, buyUsd: 0, reserveNative: EVM_FEE_RESERVE_NATIVE, reason: 'BAD_AMOUNT' };
  }
  const spendableUsd = Math.max(0, balanceNative - EVM_FEE_RESERVE_NATIVE) * price;
  if (spendableUsd <= 0) {
    return { ok: false, balanceNative, buyUsd: 0, reserveNative: EVM_FEE_RESERVE_NATIVE, reason: 'NO_SPENDABLE' };
  }
  if (wanted > spendableUsd) {
    return { ok: false, balanceNative, buyUsd: spendableUsd, reserveNative: EVM_FEE_RESERVE_NATIVE, reason: 'LOW_BALANCE' };
  }
  return { ok: true, balanceNative, buyUsd: wanted, reserveNative: EVM_FEE_RESERVE_NATIVE, reason: 'OK' };
}
