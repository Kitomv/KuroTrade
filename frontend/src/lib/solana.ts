// Solana helpers for real trading mode (Phantom). No private keys here — the
// wallet adapter handles signing; this module only reads chain state + builds
// requests to our Jupiter proxy.
import { Connection } from '@solana/web3.js';

/** RPC endpoint — override with VITE_SOLANA_RPC for a private/paid RPC. */
export const SOLANA_RPC =
  (import.meta.env.VITE_SOLANA_RPC as string | undefined) || 'https://api.mainnet-beta.solana.com';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;

export function getConnection() {
  return new Connection(SOLANA_RPC, 'confirmed');
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
