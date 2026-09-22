// Ed25519 signature verification using Node's built-in crypto (zero new deps).
// Importers/callers: realIntent.js (bindWallet / verifyWalletBinding).
// Affected API: none directly — powers POST /api/real/bind.
// Data schema: none (pure crypto helpers); bind message format is
// `dex-trade-bind:<userId>:<base58PubKey>:<nonce>` encoded as UTF-8 bytes.
// User instruction: "improve keamanan dari hacker" → nonce-bound, single-use
// bind challenge (anti-replay); platform crypto only (no hand-rolled curve math).
import { verify, createPublicKey } from 'crypto';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58 (Solana address/signature encoding) to bytes.
 *  Classic carry-accumulate algorithm — correct for multi-byte numbers (a 32-byte
 *  Solana pubkey is ~43 base58 chars, which exercises the carry path). */
export function bs58Decode(str) {
  const bytes = [0];
  for (const ch of str) {
    let carry = B58_ALPHABET.indexOf(ch);
    if (carry === -1) throw new Error('base58 tidak valid');
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1' characters are leading zero bytes.
  let zeros = 0;
  for (const ch of str) { if (ch === '1') zeros++; else break; }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** Encode bytes to base58 — inverse of bs58Decode (used by tests + tooling). */
export function bs58Encode(bytes) {
  const input = Uint8Array.from(bytes);
  let zeros = 0;
  for (const b of input) { if (b === 0) zeros++; else break; }
  const digits = [0];
  for (const b of input) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a Node KeyObject for a base58-encoded 32-byte Ed25519 public key. */
function pubKeyToKeyObject(base58) {
  const bytes = bs58Decode(base58);
  if (bytes.length !== 32) throw new Error('publicKey harus 32 byte');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: base64Url(bytes), alg: 'EdDSA', use: 'sig', ext: true },
    format: 'jwk',
  });
}

/**
 * Verify an Ed25519 signature over `message` (string → UTF-8 bytes) against a
 * base58 public key and base64 signature. Returns boolean; throws on malformed
 * base58 public keys so callers can distinguish "bad input" from "bad signature".
 */
export function verifyEd25519(base58PubKey, message, signatureBase64) {
  const key = pubKeyToKeyObject(base58PubKey); // throws on malformed key
  try {
    const sig = Buffer.from(String(signatureBase64), 'base64');
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(String(message), 'utf-8'), key, sig);
  } catch {
    return false;
  }
}

/** Canonical bind message — must match the client byte-for-byte. The nonce is
 *  single-use and server-issued, so a captured signature cannot be replayed. */
export function buildBindMessage(userId, publicKey, nonce) {
  return `dex-trade-bind:${userId}:${publicKey}:${nonce}`;
}
