// Intent state-machine tests — the money path that had zero coverage before
// the MetaMask migration. No network, no keystore: pure state transitions.
// Run: node --test backend/src/realIntent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set BEFORE the module graph is imported: persistence.js reads
// DATA_DIR at module-evaluation time, and ESM hoists imports above statements.
// Without this the tests would read and write real user state in backend/data.
const TEMP_DIR = join(tmpdir(), `intent-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const {
  addRealIntent, getRealIntents, getRealIntent, setRealIntentStatus,
  resolveIntentAsDone, setRealMode, isRealMode, getBoundWallet,
  createBindChallenge, bindWallet,
} = await import('./realIntent.js');
const { Wallet } = await import('ethers');

const uid = (s) => `u_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const ADDR = '0x1111111111111111111111111111111111111111';

function buyIntent(userId, overrides = {}) {
  return addRealIntent(userId, {
    symbol: 'TEST',
    tokenAddress: ADDR,
    chainId: 'base',
    side: 'buy',
    source: 'STRONG_BUY',
    amountUsd: 10,
    amountWei: 3_000_000_000_000_000,
    estTokens: 100,
    intentPrice: 0.1,
    ...overrides,
  });
}

test('new intent starts open and is retrievable by id', () => {
  const u = uid('open');
  const intent = buyIntent(u);
  assert.equal(intent.status, 'open');
  assert.equal(getRealIntent(u, intent.id).id, intent.id);
  assert.equal(getRealIntent(u, 'int_missing'), null);
});

test('guarded transitions: open -> active -> done', () => {
  const u = uid('happy');
  const intent = buyIntent(u);
  const claimed = setRealIntentStatus(u, intent.id, 'active', 'tok-1');
  assert.equal(claimed.status, 'active');
  assert.equal(claimed.claimToken, 'tok-1');
  assert.equal(setRealIntentStatus(u, intent.id, 'done', 'tok-1').status, 'done');
});

test('illegal transitions throw instead of silently applying', () => {
  const u = uid('illegal');
  const intent = buyIntent(u);
  // open -> done is NOT allowed on the claim path (resolveIntentAsDone exists
  // for the server-side close); a direct call must be rejected.
  assert.throws(() => setRealIntentStatus(u, intent.id, 'done'), /transisi tidak valid/);
  assert.equal(getRealIntent(u, intent.id).status, 'open');
});

test('a second claim cannot hijack an intent already active', () => {
  const u = uid('claim');
  const intent = buyIntent(u);
  setRealIntentStatus(u, intent.id, 'active', 'tok-A');
  // Rejected by the transition gate (active -> active is not an allowed edge),
  // so the original claim token survives untouched.
  assert.throws(() => setRealIntentStatus(u, intent.id, 'active', 'tok-B'), /transisi tidak valid/);
  assert.equal(getRealIntent(u, intent.id).claimToken, 'tok-A');
});

test('done requires the matching claim token', () => {
  const u = uid('token');
  const intent = buyIntent(u);
  setRealIntentStatus(u, intent.id, 'active', 'tok-A');
  // Another session's token must not be able to close this intent.
  assert.throws(() => setRealIntentStatus(u, intent.id, 'done', 'tok-B'), /another session/);
  assert.equal(setRealIntentStatus(u, intent.id, 'done', 'tok-A').status, 'done');
});

test('confirming done twice is idempotent (no double bookkeeping)', () => {
  const u = uid('idem');
  const intent = buyIntent(u);
  setRealIntentStatus(u, intent.id, 'active', 'tok-1');
  const first = setRealIntentStatus(u, intent.id, 'done', 'tok-1');
  const second = setRealIntentStatus(u, intent.id, 'done', 'tok-1');
  assert.equal(first.status, 'done');
  assert.equal(second.status, 'done');
  assert.equal(second.resolvedAt, first.resolvedAt, 'resolvedAt must not be rewritten');
});

test('resolveIntentAsDone closes an open intent without a claim (force path)', () => {
  const u = uid('force');
  const intent = buyIntent(u);
  const done = resolveIntentAsDone(u, intent.id, { force: true });
  assert.equal(done.status, 'done');
  // Idempotent: a retry must not re-apply ledger side-effects.
  assert.equal(resolveIntentAsDone(u, intent.id, { force: true }).resolvedAt, done.resolvedAt);
});

test('an intent on a non-EVM chain is auto-cancelled and cannot be filled', () => {
  const u = uid('chain');
  // Simulates a persisted intent from before the migration.
  const intent = buyIntent(u, { chainId: 'solana' });
  const listed = getRealIntents(u).find((i) => i.id === intent.id);
  assert.equal(listed.status, 'cancelled');
  assert.equal(listed.cancelReason, 'unsupported_chain');
});

test('an intent with NO chainId is left alone, not guessed at', () => {
  const u = uid('nochain');
  const intent = buyIntent(u, { chainId: undefined });
  const listed = getRealIntents(u).find((i) => i.id === intent.id);
  assert.equal(listed.status, 'open', 'a chain-less intent must not be auto-cancelled');
});

test('real mode defaults off and round-trips', () => {
  const u = uid('mode');
  assert.equal(isRealMode(u), false);
  assert.equal(setRealMode(u, true).realMode, true);
  assert.equal(isRealMode(u), true);
  assert.equal(setRealMode(u, false).realMode, false);
});

test('bind challenge is single-use: replaying the same signature fails', async () => {
  const u = uid('bind');
  const wallet = Wallet.createRandom();

  const { message } = createBindChallenge(u, wallet.address);
  const signature = await wallet.signMessage(message);

  const result = bindWallet(u, wallet.address, signature);
  assert.equal(result.bound, true);
  assert.equal(getBoundWallet(u).toLowerCase(), wallet.address.toLowerCase());

  // The nonce was consumed — a captured signature cannot be replayed.
  assert.throws(() => bindWallet(u, wallet.address, signature), /Challenge bind tidak ditemukan/);
});

test('bind rejects a signature from a different wallet', async () => {
  const u = uid('bindbad');
  const real = Wallet.createRandom();
  const attacker = Wallet.createRandom();

  const { message } = createBindChallenge(u, real.address);
  const forged = await attacker.signMessage(message);

  assert.throws(() => bindWallet(u, real.address, forged), /Signature wallet tidak valid/);
  assert.equal(getBoundWallet(u), null);
});

test('bind cannot proceed without a challenge', () => {
  const u = uid('nochallenge');
  assert.throws(
    () => bindWallet(u, ADDR, '0x' + '00'.repeat(65)),
    /Challenge bind tidak ditemukan/,
  );
});
