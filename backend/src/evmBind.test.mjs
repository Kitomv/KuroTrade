// EIP-191 bind verification tests. No network, no keystore — pure crypto.
// Run: node --test backend/src/evmBind.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { buildBindMessage, buildLoginMessage, recoverSigner, verifyEvmSignature } from './evmBind.js';

const USER = 'user-abc-123';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('valid personal_sign signature verifies and recovers the signer', async () => {
  const wallet = Wallet.createRandom();
  const message = buildBindMessage(USER, wallet.address, NONCE);
  const signature = await wallet.signMessage(message);

  assert.equal(verifyEvmSignature(wallet.address, message, signature), true);
  // The recovered address is the authority — callers store THIS, never the
  // address from the request body.
  assert.equal(recoverSigner(message, signature).toLowerCase(), wallet.address.toLowerCase());
});

test('signature from a DIFFERENT wallet is rejected', async () => {
  const signer = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const message = buildBindMessage(USER, signer.address, NONCE);
  const signature = await signer.signMessage(message);

  // Same valid signature, but claimed by another address.
  assert.equal(verifyEvmSignature(attacker.address, message, signature), false);
});

test('signature over a DIFFERENT message is rejected', async () => {
  const wallet = Wallet.createRandom();
  const message = buildBindMessage(USER, wallet.address, NONCE);
  const signature = await wallet.signMessage(message);

  // A nonce swapped in after signing must not validate — this is what makes
  // the challenge single-use against a captured signature.
  const tampered = buildBindMessage(USER, wallet.address, 'ffffffffffffffffffffffffffffffff');
  assert.equal(verifyEvmSignature(wallet.address, tampered, signature), false);
});

test('address binding is case-insensitive across checksum casings', async () => {
  const wallet = Wallet.createRandom();
  const message = buildBindMessage(USER, wallet.address, NONCE);
  const signature = await wallet.signMessage(message);

  assert.equal(verifyEvmSignature(wallet.address.toLowerCase(), message, signature), true);
  assert.equal(verifyEvmSignature(wallet.address.toUpperCase().replace('0X', '0x'), message, signature), true);
});

test('malformed signatures are rejected, never thrown', () => {
  const wallet = Wallet.createRandom();
  const message = buildBindMessage(USER, wallet.address, NONCE);

  for (const bad of ['', '0x', 'not-hex', '0xdeadbeef', null, undefined, 12345]) {
    assert.equal(recoverSigner(message, bad), null, `recoverSigner should reject ${JSON.stringify(bad)}`);
    assert.equal(verifyEvmSignature(wallet.address, message, bad), false);
  }
});

test('malformed claimed address is rejected before any recovery', () => {
  const wallet = Wallet.createRandom();
  const message = buildBindMessage(USER, wallet.address, NONCE);
  for (const bad of ['', '0x123', 'not-an-address', null]) {
    assert.equal(verifyEvmSignature(bad, message, '0x' + '00'.repeat(65)), false);
  }
});

test('bind message format is stable across the wallet migration', () => {
  // Persisted bind challenges predate this module; the format must not drift or
  // an in-flight challenge would stop verifying after a deploy.
  assert.equal(
    buildBindMessage('u1', '0xABCdef0000000000000000000000000000000001', 'n1'),
    'dex-trade-bind:u1:0xABCdef0000000000000000000000000000000001:n1',
  );
});

test('login message format is stable', () => {
  // The client signs this string byte-for-byte, so the format is a contract.
  assert.equal(
    buildLoginMessage('0xABCdef0000000000000000000000000000000001', 'n1'),
    'dex-trade-login:0xABCdef0000000000000000000000000000000001:n1',
  );
});

test('a login signature recovers the signer', async () => {
  const wallet = Wallet.createRandom();
  const message = buildLoginMessage(wallet.address, NONCE);
  const signature = await wallet.signMessage(message);
  assert.equal(recoverSigner(message, signature), wallet.address);
});

test('a login signature cannot be replayed into the bind flow', async () => {
  // The two messages are different strings on purpose. A login challenge is
  // pre-auth and has no userId, so if the two formats ever collided, a
  // signature captured at login could be presented to /api/real/bind.
  const wallet = Wallet.createRandom();
  const loginMessage = buildLoginMessage(wallet.address, NONCE);
  const bindMessage = buildBindMessage('u1', wallet.address, NONCE);
  assert.notEqual(loginMessage, bindMessage, 'the two message formats must differ');

  const signature = await wallet.signMessage(loginMessage);
  // recoverSigner never returns null for a well-formed signature: EIP-191
  // always recovers SOME address. Presenting the login signature as a bind
  // recovers a different address, which is what the comparison rejects.
  assert.notEqual(recoverSigner(bindMessage, signature), wallet.address);
  assert.equal(
    verifyEvmSignature(wallet.address, bindMessage, signature),
    false,
    'the bind verifier must refuse a signature made over the login message',
  );
});

test('a signature over an unrelated message recovers to a different signer', async () => {
  const wallet = Wallet.createRandom();
  const signature = await wallet.signMessage('some other message');
  const loginMessage = buildLoginMessage(wallet.address, NONCE);
  assert.notEqual(recoverSigner(loginMessage, signature), wallet.address);
  assert.equal(verifyEvmSignature(wallet.address, loginMessage, signature), false);
});
