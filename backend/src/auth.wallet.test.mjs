// Wallet-login tests: the address→account resolution and the challenge rules.
//
// The crypto itself is covered in evmBind.test.mjs. What matters here is that
// an address maps to exactly one account, that a wallet-only record cannot be
// reached by a password login, and that the guards added alongside wallet login
// (one address per account, case-insensitive bound comparison) hold.
// Run: node --test backend/src/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEMP_DIR = join(tmpdir(), `wallet-auth-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const {
  createUserWithAddress, findUserByAddress, createUser, verifyUser, listUsers,
  createBindChallenge, bindWallet, setBoundWallet, assertBoundWallet, getBoundWallet,
} = await import('./auth.js').then(async (auth) => ({
  ...auth,
  ...(await import('./realIntent.js')),
}));

const ADDR = '0xAbCdEf0000000000000000000000000000000001';
let seq = 0;
const fresh = () => `wlt_${process.pid}_${seq++}`;
const users = () => JSON.parse(readFileSync(join(TEMP_DIR, 'users.json'), 'utf8'));

/* ---------------- address → account ---------------- */

test('a wallet-only account is created without any password material', () => {
  const user = createUserWithAddress(ADDR);
  assert.ok(user.id);
  assert.equal(user.address, ADDR.toLowerCase(), 'stored in canonical lowercase form');

  const record = users().find((u) => u.id === user.id);
  assert.equal(record.hash, undefined, 'no hash — there is no password to hash');
  assert.equal(record.salt, undefined, 'no salt');
  assert.equal(record.password, undefined, 'no plaintext password field');
});

test('signing with the same wallet twice returns the SAME account', () => {
  const first = createUserWithAddress(ADDR);
  const second = createUserWithAddress(ADDR.toUpperCase().replace('0X', '0x'));
  assert.equal(second.id, first.id, 'a second sign must not mint a second account');
  assert.equal(users().filter((u) => u.address === ADDR.toLowerCase()).length, 1, 'exactly one record');
});

test('findUserByAddress resolves across checksum casings and rejects junk', () => {
  createUserWithAddress(ADDR);
  for (const casing of [ADDR, ADDR.toLowerCase(), ADDR.toUpperCase().replace('0X', '0x')]) {
    assert.ok(findUserByAddress(casing), `should resolve ${casing}`);
    assert.equal(findUserByAddress(casing).address, ADDR.toLowerCase());
  }
  for (const bad of ['', '0x123', 'not-an-address', null, undefined, 42, {}]) {
    assert.equal(findUserByAddress(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a wallet-only account cannot be reached through password login', () => {
  createUserWithAddress(ADDR);
  // It has no username, so username login has nothing to match — and no hash,
  // so even a guessed username could not authenticate.
  assert.equal(users().filter((u) => u.address === ADDR.toLowerCase())[0].username ?? null, null);
  assert.equal(verifyUser(ADDR, ''), null);
  assert.equal(verifyUser(ADDR.toLowerCase(), 'anything'), null);
});

test('listUsers exposes the address but never credential material', () => {
  const u = createUserWithAddress(ADDR);
  const [row] = listUsers().filter((x) => x.id === u.id);
  assert.equal(row.address, ADDR.toLowerCase());
  assert.equal(row.hash, undefined);
  assert.equal(row.salt, undefined);
});

/* ---------------- one address, one account ---------------- */

test('an address already claimed by another account cannot be bound', async () => {
  const { Wallet } = await import('ethers');
  const wallet = Wallet.createRandom();
  const address = wallet.address;

  // Wallet login provisions the account that owns this address.
  const owner = createUserWithAddress(address);
  // A second, separate account tries to bind the same wallet.
  const otherId = createUser('victim_' + fresh(), 'password12345').id;
  assert.notEqual(owner.id, otherId, 'two distinct accounts');

  // The second account CAN produce a valid signature — it controls the key —
  // which is exactly why the ownership guard has to exist.
  const { message } = createBindChallenge(otherId, address);
  const signature = await wallet.signMessage(message);

  assert.throws(
    () => bindWallet(otherId, address, signature),
    /sudah terhubung ke akun lain/,
    'a valid signature must not be enough to steal an address already claimed',
  );
  assert.equal(getBoundWallet(otherId), null, 'the refused bind left no state behind');
  assert.equal(getBoundWallet(owner.id), null, 'and did not touch the owner either');
});

test('setBoundWallet records a proven address without a challenge', () => {
  const u = fresh();
  const r = setBoundWallet(u, ADDR);
  assert.equal(r.bound, true);
  assert.equal(getBoundWallet(u), ADDR);
  assert.ok(assertBoundWallet(u, ADDR), 'the bound wallet passes its own gate');
});

test('the bound-wallet gate compares case-insensitively', () => {
  const u = fresh();
  setBoundWallet(u, ADDR); // stored checksummed
  // A caller may send the all-lowercase form; a case-sensitive compare would
  // refuse a legitimate swap from the user's own wallet.
  assert.ok(assertBoundWallet(u, ADDR.toLowerCase()), 'lowercase must match a checksummed binding');
  assert.ok(assertBoundWallet(u, ADDR.toUpperCase().replace('0X', '0x')), 'uppercase must match too');
  assert.throws(
    () => assertBoundWallet(u, '0x0000000000000000000000000000000000000000'),
    /tidak cocok/,
    'a different address is still refused',
  );
});

test('an unbound user is refused by the gate', () => {
  const u = fresh();
  assert.throws(() => assertBoundWallet(u, ADDR), /belum di-bind/);
});
