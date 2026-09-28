// EIP-191 personal_sign verification using ethers (already a dependency).
// Importers/callers: realIntent.js (bindWallet / createBindChallenge).
// Replaces ed25519.js, which verified base58 Ed25519 signatures (Solana wallets).
//
// Bind message format is unchanged (`dex-trade-bind:<userId>:<address>:<nonce>`)
// so persisted state stays readable across the wallet migration; only the
// verification primitive changed, from Ed25519/base58 to secp256k1/recover.
//
// Why recover rather than verify-against-a-known-key: EIP-191 signing recovers
// the signer from the signature, so one call both proves the signature is valid
// AND reveals who made it. That recovered address is what gets stored — never
// the address from the request body.
import { verifyMessage, getAddress, isAddress } from 'ethers';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Canonical bind message — must match the client byte-for-byte. */
export function buildBindMessage(userId, address, nonce) {
  return `dex-trade-bind:${userId}:${address}:${nonce}`;
}

/**
 * Recover the signer of an EIP-191 personal_sign signature.
 *
 * Returns the checksummed address, or null when the signature is malformed or
 * does not recover. Never throws for bad input — callers treat null as
 * "signature tidak valid" and must NOT fall back to the claimed address.
 */
export function recoverSigner(message, signature) {
  let sig = String(signature ?? '');
  // MetaMask returns 0x-prefixed hex; a bare base64 form is accepted too since
  // some routers hand back the raw 65-byte buffer.
  if (!/^0x[0-9a-fA-F]+$/.test(sig)) {
    try {
      sig = '0x' + Buffer.from(sig, 'base64').toString('hex');
    } catch {
      return null;
    }
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return null; // 65 bytes = r||s||v
  try {
    const recovered = verifyMessage(String(message), sig);
    return isAddress(recovered) ? getAddress(recovered) : null;
  } catch {
    return null;
  }
}

/** True when `signature` over `message` was produced by `expectedAddress`. */
export function verifyEvmSignature(expectedAddress, message, signature) {
  const expected = String(expectedAddress ?? '');
  if (!ADDRESS_RE.test(expected)) return false;
  const recovered = recoverSigner(message, signature);
  if (!recovered) return false;
  // Compare case-insensitively: one address has many valid checksum casings.
  return recovered.toLowerCase() === expected.toLowerCase();
}
