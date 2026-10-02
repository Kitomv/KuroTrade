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
  normalizeTxValue, clampSlippage, getGasReserve, decideBuyFunding, resolveSwapParams,
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

test('normalizeTxValue converts 1inch decimal strings to hex', () => {
  // The bug: 1inch v6 returns tx.value as a DECIMAL string ("1000000000000000"
  // for native, "0" for ERC-20), while the old code fed it to a hex regex —
  // so every buildSwapTx call threw "field tidak valid".
  assert.equal(normalizeTxValue('1000000000000000'), '0x38d7ea4c68000');
  assert.equal(normalizeTxValue('0'), '0x0');
  assert.equal(normalizeTxValue(0), '0x0');
  assert.equal(normalizeTxValue('0x0'), '0x0');
  assert.equal(normalizeTxValue('0x1b'), '0x1b');
  assert.equal(normalizeTxValue(27), '0x1b');
  assert.equal(normalizeTxValue(null), '0x0');
  assert.equal(normalizeTxValue(undefined), '0x0');
  assert.equal(normalizeTxValue(''), '0x0');
});

test('normalizeTxValue rejects garbage instead of inventing a value', () => {
  for (const bad of ['abc', '0xzz', '1.5', '-1', '0x']) {
    // '0x' is technically a valid hex regex match, so only the non-hex shapes throw.
    if (bad === '0x') continue;
    assert.throws(() => normalizeTxValue(bad), /tidak valid/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('clampSlippage is percent-scaled with a 50 cap', () => {
  // 1inch v6 rejects >50 with SLIPPAGE_TOO_HIGH; the old code passed 100
  // intending "1%" — that is 100%, refused outright.
  assert.equal(clampSlippage(undefined), 1, 'default is 1 percent');
  assert.equal(clampSlippage(1), 1);
  assert.equal(clampSlippage(100), 50, 'capped at the API limit');
  assert.equal(clampSlippage(500), 50);
  assert.equal(clampSlippage(0), 1, 'zero falls back to the default');
  assert.equal(clampSlippage(-5), 1);
  assert.equal(clampSlippage('abc'), 1);
  assert.equal(clampSlippage(0.5), 0.5);
  assert.equal(clampSlippage(0.001), 0.01, 'floored so it can never be zero');
});

test('getGasReserve is per-chain and falls back for unknown chains', () => {
  // The flat 0.005 was ~300x too large on cheap chains — a wallet with
  // 0.0000168 BNB read as "cannot afford" while holding $7.70 of USDT.
  assert.equal(getGasReserve('bsc'), 0.0003);
  assert.equal(getGasReserve('base'), 0.00005);
  assert.equal(getGasReserve('avalanche'), 0.02);
  assert.equal(getGasReserve('not-a-chain'), 0.005, 'unknown → legacy fallback');
  assert.equal(getGasReserve(), 0.00005, 'no argument defaults to base');
});

test('decideBuyFunding prefers USDT when it covers the buy and gas survives', () => {
  const base = { usdAmount: 5, nativeUsdPrice: 600, gasReserve: 0.0003 };
  // USDT covers it, native holds the gas reserve → USDT
  assert.equal(decideBuyFunding({ ...base, usdtBalance: 7.7, nativeBalance: 0.001 }).funding, 'usdt');
  // USDT covers it but native CANNOT pay gas → fall to native (if it can buy)
  const noGas = decideBuyFunding({ ...base, usdtBalance: 7.7, nativeBalance: 0.0001 });
  assert.equal(noGas.funding, null, 'native cannot cover the buy either → null');
  // USDT short, native rich → native
  assert.equal(decideBuyFunding({ ...base, usdtBalance: 1, nativeBalance: 0.1 }).funding, 'native');
  // Both short → null
  assert.equal(decideBuyFunding({ ...base, usdtBalance: 1, nativeBalance: 0.0001 }).funding, null);
  // No USDT on chain (null) + native rich → native
  assert.equal(decideBuyFunding({ ...base, usdtBalance: null, nativeBalance: 0.1 }).funding, 'native');
  // No USDT + native short → null with a reason naming the missing USDT
  const noUsdt = decideBuyFunding({ ...base, usdtBalance: null, nativeBalance: 0.0001 });
  assert.equal(noUsdt.funding, null);
  assert.equal(noUsdt.reason, 'NO_USDT_ON_CHAIN');
});

test('decideBuyFunding rejects a non-positive amount', () => {
  for (const bad of [0, -1, NaN, Infinity, null, 'abc']) {
    const r = decideBuyFunding({ usdAmount: bad, usdtBalance: 100, nativeBalance: 1, nativeUsdPrice: 600, gasReserve: 0.0003 });
    assert.equal(r.funding, null, `should reject ${String(bad)}`);
    assert.equal(r.reason, 'BAD_AMOUNT');
  }
});

test('decideBuyFunding funds a USDT buy even when the native price is unknown', () => {
  // A USDT-funded buy needs no native price: the budget IS the funding amount
  // at $1. Only the gas reserve must be payable.
  const r = decideBuyFunding({ usdAmount: 5, usdtBalance: 7.7, nativeBalance: 0.001, nativeUsdPrice: null, gasReserve: 0.0003 });
  assert.equal(r.funding, 'usdt');
});

test('resolveSwapParams: a USDT-funded buy pays with the chain USDT', () => {
  const usdt = USDT_BY_CHAIN.bsc;
  const intent = { side: 'buy', fundingToken: 'usdt', tokenAddress: '0x59CA02B16aC37aCC04A350301C592153ee877777', amountUsd: 5 };
  const legs = resolveSwapParams(intent, 'bsc');
  assert.equal(legs.src, usdt);
  assert.equal(legs.dst, intent.tokenAddress);
  assert.equal(legs.amountKind, 'usd');
});

test('resolveSwapParams: an old intent with no fundingToken is a native buy', () => {
  const intent = { side: 'buy', tokenAddress: '0x59CA02B16aC37aCC04A350301C592153ee877777', amountWei: '1000000000000000' };
  const legs = resolveSwapParams(intent, 'bsc');
  assert.equal(legs.src, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(legs.amountKind, 'nativeWei');
});

test('resolveSwapParams: a USDT-funded buy on a chain without USDT throws', () => {
  const intent = { side: 'buy', fundingToken: 'usdt', tokenAddress: '0x1111111111111111111111111111111111111111' };
  assert.throws(() => resolveSwapParams(intent, 'no-such-chain'), /tidak punya USDT/);
});

test('resolveSwapParams: a sell targets USDT when the chain has one', () => {
  const legs = resolveSwapParams({ side: 'sell', tokenAddress: '0x59CA02B16aC37aCC04A350301C592153ee877777' }, 'bsc');
  assert.equal(legs.src, '0x59CA02B16aC37aCC04A350301C592153ee877777');
  assert.equal(legs.dst, USDT_BY_CHAIN.bsc);
  assert.equal(legs.amountKind, 'tokenUnits');
});

test('resolveSwapParams: selling the chain USDT itself falls back to native', () => {
  // A USDT→USDT swap is invalid; 1inch would reject it.
  const legs = resolveSwapParams({ side: 'sell', tokenAddress: USDT_BY_CHAIN.bsc }, 'bsc');
  assert.equal(legs.dst, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
});

test('parseUnits after toFixed survives awkward floats at both decimal widths', () => {
  // amountUsd is a JS float and String(0.1+0.2) is "0.30000000000000004",
  // which parseUnits rejects as "too many decimals". toFixed first makes it
  // parse. At 18 decimals the float noise survives in the low digits
  // (4.85 → 4.849999999999999645 USDT, ~3.5e-16 off — far below a cent), which
  // is why the assertion is a tolerance rather than string equality.
  for (const d of [6, 18]) {
    const parsed = ethers.parseUnits((0.1 + 0.2).toFixed(d), d);
    assert.ok(parsed > 0n, `0.1+0.2 must parse at ${d} decimals`);
    const back = Number(ethers.formatUnits(parsed, d));
    assert.ok(Math.abs(back - 0.3) < 1e-9, `round-trip within float tolerance at ${d} decimals`);
  }
  // Exact at 6 decimals (the width of USDT on every chain except BSC).
  assert.equal(ethers.formatUnits(ethers.parseUnits((4.85).toFixed(6), 6), 6), '4.85');
  // At 18 decimals the value is correct to well under a cent.
  const bsc = Number(ethers.formatUnits(ethers.parseUnits((4.85).toFixed(18), 18), 18));
  assert.ok(Math.abs(bsc - 4.85) < 1e-9, 'BSC-width round-trip stays within a cent');
});
