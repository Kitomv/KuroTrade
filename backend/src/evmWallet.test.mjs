// EVM execution-layer guards. The keystore tests are gone with the keystore:
// there is no server-held private key any more, so what is worth testing are
// the security boundaries that replaced it.
// Run: node --test backend/src/evmWallet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  isAllowedRouter, isSupportedChain, checkTradeSize, listEvmChains,
  USDT_BY_CHAIN, knownSymbol, groupTokensByChain,
} from './evmWallet.js';

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

test('every USDT address is a canonical checksummed address for a supported chain', () => {
  // A typo here is silent: it tracks the wrong contract or mislabels a
  // stranger's token as a $1 stablecoin. The boot-time guard in evmWallet.js
  // throws on the same condition, and this pins it so a regression fails CI.
  for (const [chain, addr] of Object.entries(USDT_BY_CHAIN)) {
    assert.equal(isSupportedChain(chain), true, `${chain} should be a supported chain`);
    assert.equal(ethers.getAddress(addr), addr, `${chain} must round-trip through getAddress`);
  }
  // One address per chain — no accidental copy-paste between two entries.
  const seen = new Set(Object.values(USDT_BY_CHAIN).map((a) => a.toLowerCase()));
  assert.equal(seen.size, Object.keys(USDT_BY_CHAIN).length, 'addresses must be unique');
});

test('knownSymbol is chain-scoped: a USDT address on the wrong chain is not USDT', () => {
  const baseUsdt = USDT_BY_CHAIN.base;
  assert.equal(knownSymbol('base', baseUsdt), 'USDT');
  // Case-insensitive on the address, but never chain-blind: the same literal
  // on another chain is a different contract and must NOT resolve.
  assert.equal(knownSymbol('base', baseUsdt.toUpperCase().replace('0X', '0x')), 'USDT');
  assert.equal(knownSymbol('ethereum', baseUsdt), null);
  assert.equal(knownSymbol('unknown-chain', baseUsdt), null);
  assert.equal(knownSymbol('base', '0x00000000000000000000000000000000deadbeef'), null);
  assert.equal(knownSymbol('base', null), null);
});

test('groupTokensByChain buckets positions by the chain they were opened on', () => {
  const grouped = groupTokensByChain([
    { tokenAddress: '0xAAA0000000000000000000000000000000000001', chainId: 'bsc' },
    { tokenAddress: '0xBBB0000000000000000000000000000000000002', chainId: 'bsc' },
    { tokenAddress: '0xCCC0000000000000000000000000000000000003', chainId: 'base' },
  ]);
  assert.deepEqual(grouped, {
    bsc: ['0xAAA0000000000000000000000000000000000001', '0xBBB0000000000000000000000000000000000002'],
    base: ['0xCCC0000000000000000000000000000000000003'],
  });
});

test('groupTokensByChain defaults a legacy position with no chainId to base', () => {
  // wallet.js records old positions with a base default; valuation must read
  // the chain they were actually recorded on, not guess another one.
  const grouped = groupTokensByChain([{ tokenAddress: '0xDDD0000000000000000000000000000000000004' }]);
  assert.deepEqual(grouped, { base: ['0xDDD0000000000000000000000000000000000004'] });
});

test('groupTokensByChain drops positions it cannot safely read', () => {
  const grouped = groupTokensByChain([
    { tokenAddress: '0xEEE0000000000000000000000000000000000005', chainId: 'solana' }, // unsupported chain
    { tokenAddress: '', chainId: 'base' },        // no address
    { chainId: 'base' },                          // no address
    null,
    { tokenAddress: '0xFFF0000000000000000000000000000000000006', chainId: 'ethereum' }, // kept
  ]);
  // A dropped position is deliberate: there is no RPC that could read it, and
  // guessing a chain would value a stranger's contract at that address.
  assert.deepEqual(grouped, { ethereum: ['0xFFF0000000000000000000000000000000000006'] });
});

test('groupTokensByChain handles an empty or absent list', () => {
  assert.deepEqual(groupTokensByChain([]), {});
  assert.deepEqual(groupTokensByChain(undefined), {});
  assert.deepEqual(groupTokensByChain(null), {});
});
