// Legacy wallet-account tests.
//
// Wallet LOGIN is gone — an account is now created only by an admin. What
// remains here is the shape of a wallet-only record that predates that removal
// (username null, no password material): it must not be reachable through the
// password login, and binding a wallet to an account must still refuse a wallet
// that another account already owns.
// Run: node --test backend/src/auth.wallet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEMP_DIR = join(tmpdir(), `wallet-auth-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const {
  findUserByAddress, createUser, verifyUser, listUsers,
  createBindChallenge, bindWallet, setBoundWallet, assertBoundWallet, getBoundWallet,
} = await import('./auth.js').then(async (auth) => ({
  ...auth,
  ...(await import('./realIntent.js')),
}));

const ADDR = '0xAbCdEf0000000000000000000000000000000001';
let seq = 0;
const fresh = () => `wlt_${process.pid}_${seq++}`;
const usersFile = join(TEMP_DIR, 'users.json');
// The file does not exist until something writes it — a legacy-record test may
// be the first thing to run, so treat "absent" as "no users yet".
const users = () => {
  try { return JSON.parse(readFileSync(usersFile, 'utf8')); } catch { return []; }
};

/**
 * Write a wallet-only record the way the removed wallet-login flow did: no
 * username, no salt, no hash. Tests below pin what must stay true of such a
 * record now that nothing can create one.
 */
const writeLegacyWalletUser = (address) => {
  const record = { id: `legacy_${fresh()}`, address: String(address).toLowerCase(), username: null, createdAt: Date.now() };
  writeFileSync(usersFile, JSON.stringify([...users(), record], null, 2), 'utf8');
  return record;
};

/* ---------------- legacy wallet-only records ---------------- */

test('a legacy wallet-only record has no password material to attack', () => {
  const record = writeLegacyWalletUser(ADDR);
  assert.equal(record.hash, undefined, 'no hash — there is no password to hash');
  assert.equal(record.salt, undefined, 'no salt');
  assert.equal(record.password, undefined, 'no plaintext password field');
});

test('findUserByAddress resolves across checksum casings and rejects junk', () => {
  writeLegacyWalletUser(ADDR);
  for (const casing of [ADDR, ADDR.toLowerCase(), ADDR.toUpperCase().replace('0X', '0x')]) {
    assert.ok(findUserByAddress(casing), `should resolve ${casing}`);
    assert.equal(findUserByAddress(casing).address, ADDR.toLowerCase());
  }
  for (const bad of ['', '0x123', 'not-an-address', null, undefined, 42, {}]) {
    assert.equal(findUserByAddress(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a legacy wallet-only record cannot be reached through password login', () => {
  writeLegacyWalletUser(ADDR);
  // It has no username, so username login has nothing to match — and no hash,
  // so even a guessed username could not authenticate.
  assert.equal(users().find((u) => u.address === ADDR.toLowerCase()).username ?? null, null);
  assert.equal(verifyUser(ADDR, ''), null);
  assert.equal(verifyUser(ADDR.toLowerCase(), 'anything'), null);
});

test('listUsers exposes the address but never credential material', () => {
  const record = writeLegacyWalletUser(ADDR);
  const row = listUsers().find((x) => x.id === record.id);
  assert.equal(row.address, ADDR.toLowerCase());
  assert.equal(row.hash, undefined);
  assert.equal(row.salt, undefined);
});

/* ---------------- one address, one account ---------------- */

test('an address already claimed by another account cannot be bound', async () => {
  const { Wallet } = await import('ethers');
  const wallet = Wallet.createRandom();
  const address = wallet.address;

  // A legacy wallet-only record owns this address.
  writeLegacyWalletUser(address);
  const owner = findUserByAddress(address);
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
