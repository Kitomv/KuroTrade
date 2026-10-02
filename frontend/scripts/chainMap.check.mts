// Verifies the chain-id mapping used by the portfolio/balance panels.
// Run: npm run check  (from frontend/)
//
// The bug being guarded: chainKeyFromId used to fall back to 'base' for any
// unknown chain, so a wallet on an unsupported network silently showed Base
// balances as if they were its own. It must return null instead — the panels
// now render an explicit "chain belum didukung" state.

import {
  chainKeyFromId, chainNameFromId, CHAIN_KEY_BY_ID, NATIVE_SYMBOL_BY_CHAIN,
} from '../src/lib/evm.ts';

const log: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

// --- chainKeyFromId: unknown chains must NOT default to base ---
check('no chain id → null, never a silent base', chainKeyFromId(null), null);
check('empty read → null', chainKeyFromId(''), null);
check('base maps through', chainKeyFromId('0x2105'), 'base');
check('unsupported chain → null', chainKeyFromId('0x144'), null);
check('every backend chain key resolves both ways',
  Object.entries(CHAIN_KEY_BY_ID).every(([id, key]) => chainKeyFromId(id) === key), true);
check('every backend chain has a native symbol',
  Object.values(CHAIN_KEY_BY_ID).every((k) => Boolean(NATIVE_SYMBOL_BY_CHAIN[k])), true);

// --- chainNameFromId: labels, not raw hex ---
check('chainNameFromId accepts hex', chainNameFromId('0x2105'), 'Base');
check('chainNameFromId accepts number', chainNameFromId(8453), 'Base');
check('chainNameFromId unknown → null', chainNameFromId('0x144'), null);
check('chainNameFromId null → null', chainNameFromId(null), null);
check('name exists for every supported chain',
  Object.keys(CHAIN_KEY_BY_ID).every((id) => Boolean(chainNameFromId(id))), true);

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
