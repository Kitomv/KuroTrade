// Shared EIP-1193 helpers for the MetaMask connection. No wallet library —
// MetaMask injects `window.ethereum` and the app talks to it directly.
// The server holds the 1inch API key; the browser only ever signs.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

/** The injected provider, or null when no EVM wallet is installed. */
export function getInjectedProvider(): Eip1193Provider | null {
  return (globalThis as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

/** Ask for accounts. Must be called from a user gesture (a click). */
export async function requestAccounts(): Promise<string[]> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error('MetaMask tidak ditemukan — install ekstensi MetaMask di browser');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  return Array.isArray(accounts) ? (accounts as string[]) : [];
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
  if (!provider) throw new Error('MetaMask tidak ditemukan');
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
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
