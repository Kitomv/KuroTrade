// Roundtrip test for the platform-crypto Ed25519 verifier (zero-dep node:test).
// Run: node --test backend/src/ed25519.test.mjs
// Proves: real Solana-style base58 pubkey + base64 signature verify correctly,
// tampering fails, and malformed inputs are rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyEd25519, bs58Decode, bs58Encode, buildBindMessage } from './ed25519.js';

/** Raw 32-byte Ed25519 public key from a KeyObject's DER SPKI (last 32 bytes). */
function rawPubKey(keyObject) {
  const der = keyObject.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPubKey(publicKey);
  return { raw, publicKeyB58: bs58Encode(raw), privateKey };
}

test('base58 roundtrip preserves bytes (incl. leading zeros)', () => {
  for (const bytes of [
    new Uint8Array(32).fill(7),
    new Uint8Array([0, 0, 1, 2, 3, 255, 254, 0, 9]),
    new Uint8Array(64).map((_, i) => (i * 37) & 0xff),
  ]) {
    assert.deepEqual(Uint8Array.from(bs58Decode(bs58Encode(bytes))), bytes);
  }
});

test('valid signature verifies (bind message format)', () => {
  const { publicKeyB58, privateKey } = makeWallet();
  const message = buildBindMessage('user-1', publicKeyB58, 'nonce123');
  const signature = sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
  assert.equal(verifyEd25519(publicKeyB58, message, signature), true);
});

test('tampered message or signature fails', () => {
  const { publicKeyB58, privateKey } = makeWallet();
  const message = buildBindMessage('user-1', publicKeyB58, 'nonce123');
  const signature = sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');

  assert.equal(verifyEd25519(publicKeyB58, message + 'x', signature), false);
  const bad = Buffer.from(signature, 'base64');
  bad[0] ^= 0xff;
  assert.equal(verifyEd25519(publicKeyB58, message, bad.toString('base64')), false);
});

test('signature from a different key fails', () => {
  const a = makeWallet();
  const b = makeWallet();
  const message = buildBindMessage('user-1', a.publicKeyB58, 'nonce123');
  const signature = sign(null, Buffer.from(message, 'utf8'), b.privateKey).toString('base64');
  assert.equal(verifyEd25519(a.publicKeyB58, message, signature), false);
});

test('malformed inputs are rejected', () => {
  const { publicKeyB58, privateKey } = makeWallet();
  const message = buildBindMessage('user-1', publicKeyB58, 'nonce123');
  const signature = sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');

  assert.equal(verifyEd25519(publicKeyB58, message, Buffer.alloc(10).toString('base64')), false); // wrong sig length
  assert.throws(() => verifyEd25519('!!!not-base58!!!', message, signature)); // invalid base58
  const short = bs58Encode(new Uint8Array(16).fill(3));
  assert.throws(() => verifyEd25519(short, message, signature)); // wrong key length
});

test('bind message is canonical and nonce-bound', () => {
  assert.equal(buildBindMessage('u', 'PK', 'n'), 'dex-trade-bind:u:PK:n');
});

test('exported DER SPKI prefix is the Ed25519 constant', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  assert.equal(Buffer.from(der.subarray(0, 12)).toString('hex'), '302a300506032b6570032100');
});
