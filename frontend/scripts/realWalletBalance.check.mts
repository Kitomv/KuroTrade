// Verifies the compact on-chain balance panel (Trade page sidebar). It is a
// second, independent reader of the same /api/real/portfolio payload, and it
// had to shed the same defect class the portfolio panel did — showing a number
// that is not what it claims:
//
//  1. `h.symbol === 'USDT'` — a case-sensitive match where the backend's symbol
//     comes from its own known-token table. `usdtAmount` matches case-insensitively.
//  2. `catch {}` — a swallowed error. A failed read must show a failure, never
//     stale money.
//  3. `?.amount ?? 0` — an absent USDT row was called zero even when the backend
//     had DROPPED holdings it could not price (decimals unreadable). One of those
//     could have been the USDT. A wallet holding 5,000 USDT was told "0 USDT".
//  4. Clearing state in a passive effect runs AFTER paint, so on a chain switch
//     one committed frame showed the PREVIOUS chain's numbers under the new
//     chain. Data must be tagged with the chain it was loaded for.
//
// Run: npm run check  (from frontend/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { usdtAmount, currentSnapshot } from '../src/lib/walletView.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf-8');

const log: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const assert = (label: string, ok: boolean, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
};

const tsx = read('../src/components/RealWalletBalance.tsx');
const css = read('../src/styles.css');

/* ---------- the USDT amount, via the shared helper ---------- */

// No hand-rolled symbol comparison: `h.symbol === 'usdt'` is the same bug as
// `=== 'USDT'`, so the check forbids the pattern, not just the literal.
assert('the panel does NOT hand-roll a symbol comparison',
  !/\.symbol\s*===/.test(tsx), 'still comparing .symbol by hand');
assert('the panel uses the shared usdtAmount helper',
  tsx.includes('usdtAmount('), 'USDT amount is not sourced from the tested helper');
assert('the panel feeds the backend dropped-holding count into it',
  /usdtAmount\([^)]*unpricedCount/.test(tsx),
  'unpriced holdings are ignored, so a dropped USDT reads as 0');

/* ---------- a failed load must not leave stale numbers ---------- */

// Scoped to the loader: the FIRST `catch` in the file may be a comment or an
// unrelated block. Everything from the portfolio fetch to EOF is the loader plus
// the render, which is all we need to inspect.
const fetchIdx = tsx.indexOf('api.realPortfolio');
assert('the panel still reads the portfolio endpoint', fetchIdx !== -1,
  'api.realPortfolio not found — the check below would scan an empty region');
const afterFetch = fetchIdx === -1 ? tsx : tsx.slice(fetchIdx);
assert('the load error is not swallowed',
  !/catch\s*\{\s*\}/.test(afterFetch), 'catch block is empty');
assert('a failed load records a failure state',
  /ok:\s*false/.test(afterFetch), 'catch does not record the failure');
assert('the panel renders the load failure instead of stale balances',
  /!cur\.ok/.test(tsx) && /cur\.err/.test(tsx),
  'no error branch — stale numbers can stay on screen');
// A stale snapshot is only half the bug: switching MetaMask accounts on the same
// chain leaves `chain` unchanged, so the effect must also re-run for a new address.
const deps = tsx.match(/\},\s*\[([^\]]*)\]\s*\);/)?.[1] ?? '';
assert('the loader re-runs when the wallet address changes',
  /\baddress\b/.test(deps),
  `address is not in the effect deps (${deps.trim()}) — account switch keeps the previous wallet's numbers`);

// `currentSnapshot` rejects a snapshot whose `address` tag does not match, so the
// caller must WRITE that tag. Without this, deleting `address,` from a `setLoaded`
// call survives `npm run check` (only tsc notices, and only while the field is
// required) and the panel silently shows wallet A's balances under wallet B.
const loadedCalls = [...tsx.matchAll(/setLoaded\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
assert('every snapshot is tagged with the wallet address',
  loadedCalls.length > 0 && loadedCalls.every((c) => /\baddress\b/.test(c)),
  `a setLoaded call omits the address tag (${loadedCalls.length} found)`);

/* ---------- numbers only for the chain they were loaded for ---------- */

// Behavioral, not source-text: the regression was clearing in a passive effect
// (which runs after paint), so one committed frame showed the previous chain's
// balances under the new chain. `currentSnapshot` must reject a snapshot whose
// tag does not match the live chain/address.
const snapA = { chain: 'base', address: '0xaaa', ok: true as const, native: 1, usdt: 5 };
check('a snapshot for the live chain is used', currentSnapshot(snapA, 'base', '0xaaa'), snapA);
check('a snapshot for a DIFFERENT chain is rejected',
  currentSnapshot(snapA, 'ethereum', '0xaaa'), null);
check('a snapshot for a DIFFERENT address is rejected',
  currentSnapshot(snapA, 'base', '0xbbb'), null);
check('no snapshot at all is null', currentSnapshot(null, 'base', '0xaaa'), null);

/* ---------- CSS class contract ---------- */

const classes = new Set<string>();
for (const m of tsx.matchAll(/className="([^"{}]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
}
for (const m of tsx.matchAll(/className=\{`([^`]+)`\}/g)) {
  for (const c of m[1].split(/[\s${}?:'"]+/)) if (c && /^[a-z][a-z0-9-]*$/.test(c)) classes.add(c);
}
const cssClasses = new Set<string>();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) cssClasses.add(m[1]);
const missing = [...classes].filter((c) => !cssClasses.has(c));
assert('every class the panel renders exists in styles.css',
  missing.length === 0, `missing: ${missing.join(', ')}`);

/* ---------- the USDT amount helper ---------- */

const row = (symbol: string | null, amount: number) =>
  ({ token: `0x${'1'.repeat(40)}`, symbol, amount, decimals: 6, priceUsd: 1, valueUsd: amount });

check('a present USDT row reports its amount',
  usdtAmount([row('WETH', 1), row('USDT', 1204.5)]), 1204.5);
check('a lowercase usdt symbol is still found',
  usdtAmount([row('usdt', 50)]), 50);
check('a mixed-case Usdt symbol is still found',
  usdtAmount([row('Usdt', 50)]), 50);
check('no USDT row and nothing dropped means a real zero',
  usdtAmount([row('WETH', 1)]), 0);
check('no USDT row but a dropped holding means UNKNOWN, not zero',
  usdtAmount([row('WETH', 1)], 1), null);
check('a present USDT row wins even when other holdings were dropped',
  usdtAmount([row('USDT', 50)], 2), 50);
check('an empty wallet with no drops is zero',
  usdtAmount([]), 0);
check('an empty holdings list with a drop is unknown',
  usdtAmount([], 1), null);

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
