// EVM execution-layer guards. The keystore tests are gone with the keystore:
// there is no server-held private key any more, so what is worth testing are
// the security boundaries that replaced it.
// Run: node --test backend/src/evmWallet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRouter, isSupportedChain, checkTradeSize, listEvmChains } from './evmWallet.js';

const ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const ATTACKER = '0x00000000000000000000000000000000deadbeef';

test('the 1inch router is accepted in any casing', () => {
  assert.equal(isAllowedRouter(ROUTER), true);
  assert.equal(isAllowedRouter(ROUTER.toLowerCase()), true);
  assert.equal(isAllowedRouter(ROUTER.toUpperCase().replace('0X', '0x')), true);
});

test('an arbitrary contract is NOT an allowed router', () => {
  // This is the check that replaced approve(spender, MaxUint256) with an
  // unvalidated spender. An aggregator response pointing anywhere else must be
  // refused before it can become an allowance.
  assert.equal(isAllowedRouter(ATTACKER), false);
});

test('malformed router addresses are rejected, never thrown', () => {
  for (const bad of ['', '0x', '0x123', null, undefined, 42, {}, ROUTER + 'ff', ROUTER.slice(0, -1)]) {
    assert.equal(isAllowedRouter(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('supported chains match the executor config', () => {
  for (const chain of ['base', 'ethereum', 'arbitrum', 'bsc', 'optimism', 'polygon', 'avalanche']) {
    assert.equal(isSupportedChain(chain), true, `${chain} should be supported`);
  }
  // Solana is no longer an execution target — this is the guard that stops an
  // unfillable intent from being emitted and blocking buy-dedup forever.
  assert.equal(isSupportedChain('solana'), false);
  assert.equal(isSupportedChain('unknown-chain'), false);
  assert.equal(isSupportedChain(undefined), false);
});

test('listEvmChains exposes chainId + native symbol for every chain', () => {
  const chains = listEvmChains();
  assert.equal(chains.length, 7);
  for (const c of chains) {
    assert.ok(c.key && Number.isInteger(c.chainId) && c.native && c.explorer);
  }
  assert.equal(chains.find((c) => c.key === 'base').chainId, 8453);
});

test('trade size cap rejects zero, negative, NaN and oversized amounts', () => {
  for (const bad of [0, -1, NaN, Infinity, null, 'abc']) {
    assert.equal(checkTradeSize(bad).ok, false, `should reject ${String(bad)}`);
  }
  assert.equal(checkTradeSize(10).ok, true);
  assert.equal(checkTradeSize(10).cap, 50, 'default cap is $50');
  // Above the default cap → refused with the cap echoed back so the caller can
  // downsize instead of silently dropping the trade.
  const over = checkTradeSize(500);
  assert.equal(over.ok, false);
  assert.equal(over.cap, 50);
});
