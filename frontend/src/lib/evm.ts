// Shared EIP-1193 helpers for the MetaMask connection. No wallet library —
// MetaMask injects its provider and the app talks to it directly.
// The server holds the 1inch API key; the browser only ever signs.
//
// Discovery goes through EIP-6963 rather than reading `window.ethereum` raw.
// Every wallet extension that predates EIP-6963 fights over that single slot
// and whichever injects last wins, so on a browser with Rabby/Coinbase/Trust
// installed the object at `window.ethereum` may not be MetaMask at all. When
// that happens MetaMask runs its own extension-selection fallback, which can
// throw an opaque "Unexpected error" out of its internal bundle — before the
// user has clicked anything. EIP-6963 removes the race: each wallet announces
// its own provider with a stable identity, and we pick MetaMask deliberately.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
  isMetaMask?: boolean;
}

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon?: string;
  rdns?: string;
  isMetaMask?: boolean;
}

interface Eip6963Announcement {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

const announced = new Map<string, Eip6963Announcement>();
const listeners = new Set<() => void>();
let selected: Eip1193Provider | null = null;

/** True when this announcement is MetaMask's. */
function isMetaMask(info: Eip6963ProviderInfo): boolean {
  return Boolean(info.isMetaMask) || info.rdns === 'io.metamask';
}

function pickProvider(): Eip1193Provider | null {
  const legacy = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  let firstMetaMask: Eip1193Provider | null = null;
  for (const { info, provider } of announced.values()) {
    if (!isMetaMask(info)) continue;
    // Strongest available signal: the announcement and the legacy slot agree
    // on the SAME provider object. A forged announcement can claim any name,
    // but it cannot make window.ethereum point at its provider — so when real
    // MetaMask owns the slot, the matching announcement is the real one and
    // the forged one is skipped below.
    if (legacy && provider === legacy) return provider;
    if (!firstMetaMask) firstMetaMask = provider;
  }
  // No announcement matches the slot. Prefer a genuine announcement over
  // whatever occupies window.ethereum: the slot can be overwritten by another
  // wallet or a page script, and returning it would hand the app a provider
  // that never announced itself. The no-announcement case (pre-6963 MetaMask
  // in the slot) is handled by the legacy fallback in getInjectedProvider.
  return firstMetaMask;
}

function refresh(): void {
  const next = pickProvider();
  if (next === selected) return;
  selected = next;
  for (const fn of listeners) fn();
}

function requestProviders(): void {
  if (typeof window === 'undefined') return;
  // Wallets answer synchronously during this dispatch, so the map is populated
  // by the time it returns.
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent<Eip6963Announcement>).detail;
    if (!detail?.info?.uuid || !detail.provider) return;
    announced.set(detail.info.uuid, detail);
    refresh();
  });
  requestProviders();
}

/** Notify when MetaMask becomes available (extensions may inject late). */
export function subscribeProviders(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The MetaMask provider, or null when MetaMask is not installed.
 *
 * Returns null rather than falling back to an unknown wallet: every call site
 * assumes the provider is MetaMask (personal_sign, wallet_switchEthereumChain,
 * the swap flow), and driving a different wallet through MetaMask's API shape
 * is how the opaque "Unexpected error" reached the console.
 */
export function getInjectedProvider(): Eip1193Provider | null {
  if (selected) return selected;
  // Nothing announced yet: a wallet may have injected after this module loaded
  // and only answers when asked.
  if (announced.size === 0) {
    requestProviders();
    refresh();
  }
  if (selected) return selected;
  // Legacy path — wallets without EIP-6963. Accept the injected object only if
  // it identifies itself as MetaMask.
  const legacy = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  if (legacy?.isMetaMask) {
    selected = legacy;
    return selected;
  }
  return null;
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

/** Ask for accounts. Must be called from a user gesture (a click). */
export async function requestAccounts(): Promise<string[]> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error(missingWalletMessage());
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  return Array.isArray(accounts) ? (accounts as string[]) : [];
}

/**
 * Why no MetaMask provider was found.
 *
 * "Not installed" and "installed but another wallet won the injection race"
 * need different instructions, and MetaMask's own failure in the second case is
 * an opaque "Unexpected error" that tells the user nothing.
 */
export function missingWalletMessage(): string {
  const names = [...announced.values()]
    .filter((a) => !isMetaMask(a.info))
    .map((a) => a.info.name)
    .filter((name, i, all) => all.indexOf(name) === i);
  if (names.length > 0) {
    return `MetaMask tidak terdeteksi — yang terdeteksi: ${names.join(', ')}. `
      + 'Nonaktifkan ekstensi wallet lain, lalu reload halaman ini.';
  }
  return 'MetaMask tidak ditemukan — install ekstensi MetaMask di browser';
}

/** Accounts already granted by a previous session — safe to call on load. */
export async function getAccounts(): Promise<string[]> {
  const provider = getInjectedProvider();
  if (!provider) return [];
  const accounts = await provider.request({ method: 'eth_accounts' });
  return Array.isArray(accounts) ? (accounts as string[]) : [];
}

export async function getChainIdHex(): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) return '';
  return String(await provider.request({ method: 'eth_chainId' }));
}

/** Switch the wallet to `chainId` (hex string, e.g. '0x2105' for Base). */
export async function switchChain(chainIdHex: string): Promise<void> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error(missingWalletMessage());
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
}

/** `chainId` as a 0x-prefixed hex string, e.g. 8453 -> '0x2105'. */
export function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/**
 * The chain the wallet is on right now, or '' when it cannot be read.
 *
 * Re-read rather than trusting a value captured earlier: the user can switch
 * networks in the extension at any time, including while a swap is queued.
 */
export async function currentChainIdHex(): Promise<string> {
  return getChainIdHex();
}

/** Hex-encode a UTF-8 string for personal_sign. */
function toHex(message: string): string {
  return `0x${Array.from(new TextEncoder().encode(message))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Sign an arbitrary string via EIP-191 personal_sign.
 *
 * MetaMask expects the message HEX-ENCODED in the params array. Passing a raw
 * UTF-8 string works in some wallets and silently signs the wrong bytes in
 * others — the hex round-trip is what makes the server's recovered address
 * match the wallet that actually signed.
 */
export async function personalSign(message: string, address: string): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error('MetaMask tidak ditemukan');
  return String(await provider.request({ method: 'personal_sign', params: [toHex(message), address] }));
}

/** Send a transaction. Returns the tx hash; the caller waits for the receipt. */
export async function sendTransaction(tx: {
  from: string;
  to: string;
  data?: string;
  value?: string;
  gas?: string;
}): Promise<string> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error('MetaMask tidak ditemukan');
  // Drop empty fields: MetaMask rejects '0x0' placeholders with a confusing
  // "invalid transaction" rather than "missing value".
  const payload: Record<string, string> = { from: tx.from, to: tx.to };
  if (tx.data && tx.data !== '0x') payload.data = tx.data;
  if (tx.value && tx.value !== '0x' && tx.value !== '0x0') payload.value = tx.value;
  if (tx.gas) payload.gas = tx.gas;
  return String(await provider.request({ method: 'eth_sendTransaction', params: [payload] }));
}

export interface TxReceipt {
  status: 'success' | 'reverted';
  blockNumber: number | null;
}

/** Poll until the transaction is mined, or give up after `timeoutMs`. */
export async function waitForReceipt(txHash: string, timeoutMs = 120_000): Promise<TxReceipt> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error('MetaMask tidak ditemukan');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
    if (receipt && typeof receipt === 'object' && 'status' in receipt) {
      const r = receipt as { status: string; blockNumber?: string };
      return {
        status: r.status === '0x1' ? 'success' : 'reverted',
        blockNumber: r.blockNumber ? parseInt(r.blockNumber, 16) : null,
      };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('Tx tidak terkonfirmasi dalam batas waktu — cek di explorer');
}

/** Shorten an address for display: 0x1234…abcd. Works for any chain. */
export function shortAddr(addr: string, chars = 4): string {
  return addr.length > chars * 2 + 2 ? `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}` : addr;
}

/** True when the page is served over an insecure origin (http / tunnel). */
export function isInsecureOrigin(): boolean {
  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1';
  return (location.protocol !== 'https:' && !isLocal) || h.includes('ngrok') || h.includes('trycloudflare');
}

const EXPLORERS: Record<string, string> = {
  base: 'https://basescan.org/tx/',
  ethereum: 'https://etherscan.io/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
  avalanche: 'https://snowtrace.io/tx/',
};

export function explorerTxUrl(chain: string, txHash: string): string {
  return `${EXPLORERS[chain] ?? EXPLORERS.base}${txHash}`;
}

/** Wallet chain id (hex) → backend chain key. Matches CHAINS in backend/src/evmWallet.js. */
export const CHAIN_KEY_BY_ID: Record<string, string> = {
  '0x2105': 'base',
  '0x1': 'ethereum',
  '0xa4b1': 'arbitrum',
  '0x38': 'bsc',
  '0xa': 'optimism',
  '0x89': 'polygon',
  '0xa86a': 'avalanche',
};

/**
 * Backend chain key for the wallet's current chain, or null when that chain
 * has no backend support.
 *
 * Null rather than a silent 'base' fallback: defaulting to Base read Base
 * balances while the user was on another network and presented the number as
 * the wallet's own — a wrong value the UI had no way to flag.
 */
export function chainKeyFromId(chainIdHex: string | null): string | null {
  if (!chainIdHex) return null;
  return CHAIN_KEY_BY_ID[chainIdHex.toLowerCase()] ?? null;
}

/** Backend chain key → wallet chain id (hex). Inverse of CHAIN_KEY_BY_ID. */
// `Object.create(null)` base: a plain `{}` from Object.fromEntries inherits
// Object.prototype, so a key like 'constructor' or '__proto__' would resolve to
// an inherited value instead of null — and the caller's `!wantChain` fail-closed
// guard would then pass a non-string downstream.
const CHAIN_ID_BY_KEY: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(Object.entries(CHAIN_KEY_BY_ID).map(([hex, key]) => [key, hex])),
);

/**
 * Wallet chain id (hex) for a backend chain key, or null when unknown.
 *
 * Lets a caller check the wallet's chain against an intent's stored chain
 * (`intent.chainId` is a key like 'base') BEFORE asking the server to build —
 * a mismatch is caught without consuming a claim.
 */
export function chainIdHexFromKey(chainKey: string | null): string | null {
  if (!chainKey) return null;
  const hex = CHAIN_ID_BY_KEY[chainKey.toLowerCase()];
  return typeof hex === 'string' ? hex : null;
}

/** Human chain name for display; null when the id is unknown. */
export const CHAIN_NAME_BY_ID: Record<string, string> = {
  '0x2105': 'Base',
  '0x1': 'Ethereum',
  '0xa4b1': 'Arbitrum',
  '0x38': 'BNB Chain',
  '0xa': 'Optimism',
  '0x89': 'Polygon',
  '0xa86a': 'Avalanche',
};

/** '0x2105' or 8453 → 'Base'. Null when the chain has no known name. */
export function chainNameFromId(chainId: string | number | null): string | null {
  if (chainId === null) return null;
  const hex = typeof chainId === 'number' ? `0x${chainId.toString(16)}` : chainId.toLowerCase();
  return CHAIN_NAME_BY_ID[hex] ?? null;
}

/** Native gas-coin symbol per backend chain key. */
export const NATIVE_SYMBOL_BY_CHAIN: Record<string, string> = {
  base: 'ETH',
  ethereum: 'ETH',
  arbitrum: 'ETH',
  optimism: 'ETH',
  bsc: 'BNB',
  polygon: 'POL',
  avalanche: 'AVAX',
};
