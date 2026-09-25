// Solana helpers for real trading mode (Phantom). No private keys here — the
// wallet adapter handles signing; this module only reads chain state + builds
// requests to our Jupiter proxy.
import { Connection } from '@solana/web3.js';

/**
 * RPC endpoint. Defaults to the backend's same-origin JSON-RPC proxy:
 * public RPCs (api.mainnet-beta.solana.com) return 403 to browser origins, and
 * embedding a paid key in the bundle would leak it to anyone with devtools.
 * The backend already holds the configured RPC (BACKEND_SOLANA_RPC / NETWORK).
 *
 * Override with VITE_SOLANA_RPC only for a key you are happy to expose publicly
 * (e.g. a domain-restricted key); otherwise leave it unset.
 */
export const SOLANA_RPC =
  (import.meta.env.VITE_SOLANA_RPC as string | undefined) || `${location.origin}/api/rpc`;

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Attach the session token to RPC calls. The same-origin proxy (/api/rpc) is
 * auth-guarded like every other /api route, so the wallet adapter's own
 * Connection needs this too — see ConnectionProvider config in
 * WalletProviderGate. Only applied for the same-origin proxy: an explicitly
 * configured external RPC (VITE_SOLANA_RPC) must not receive our token.
 */
export function rpcFetchMiddleware(url: string, init: RequestInit | undefined, next: (url: string, init: RequestInit) => void) {
  const headers = new Headers(init?.headers);
  if (SOLANA_RPC.startsWith(location.origin)) {
    const token = localStorage.getItem('trading_token');
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  next(url, { ...(init ?? {}), headers });
}

/** Connection config shared by getConnection() and the wallet adapter provider. */
export const RPC_CONFIG = {
  commitment: 'confirmed' as const,
  fetchMiddleware: rpcFetchMiddleware,
};

export function getConnection() {
  return new Connection(SOLANA_RPC, RPC_CONFIG as any);
}

export function shortAddr(addr: string, chars = 4) {
  return addr.length > chars * 2 + 3 ? `${addr.slice(0, chars)}…${addr.slice(-chars)}` : addr;
}

/** True when the page is served over an insecure origin (http / tunnel). */
export function isInsecureOrigin() {
  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1';
  return (location.protocol !== 'https:' && !isLocal) || h.includes('ngrok') || h.includes('trycloudflare');
}

export function solscanTxUrl(signature: string) {
  return `https://solscan.io/tx/${signature}`;
}
