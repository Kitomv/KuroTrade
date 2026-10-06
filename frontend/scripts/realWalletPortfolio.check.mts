// Verifies the real-wallet portfolio panel: its CSS class contract and the
// view math that turns an /api/real/portfolio payload into the numbers shown.
// Run: npm run check  (from frontend/)
//
// The bug being guarded: the panel emitted `kpi-label` / `kpi-value` /
// `kpi-sub`, but styles.css only ever defined `.kpi .label` / `.value` / `.sub`
// (which KpiCard.tsx uses). Those two balance cards therefore rendered with no
// mono figures, no tabular alignment, and no label tracking — silently, because
// a wrong class name is not an error in CSS. The first check below fails if any
// class the component renders is absent from the stylesheet.
//
// The math checks guard the total: the payload carries `native`, `nativeUsd`
// and `tokenValueUsd`, and a total that adds an unpriced gas coin as zero
// understates real money. That must surface as "unknown", never a number.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onChainTotalUsd, gasState, usdtRow, isReady, GAS_FLOOR } from '../src/lib/walletView.ts';

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

/* ---------- CSS class contract ---------- */

const tsx = read('../src/components/RealWalletPortfolio.tsx');
const css = read('../src/styles.css');

// The specific regression: these three were never defined anywhere.
for (const ghost of ['kpi-label', 'kpi-value', 'kpi-sub']) {
  assert(`component does not use undefined class .${ghost}`, !tsx.includes(ghost), `found .${ghost}`);
}

// Generalise it: every class the component names must exist in the stylesheet
// (or be a state class composed at runtime — checked by prefix).
const classes = new Set<string>();
for (const m of tsx.matchAll(/className="([^"{}]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
}
// Classes applied through template literals (`btn ${active ? 'on' : ''}`) are
// read from the string literals too, so runtime-composed states are covered.
for (const m of tsx.matchAll(/className=\{`([^`]+)`\}/g)) {
  for (const c of m[1].split(/[\s${}?:'"]+/)) if (c && /^[a-z][a-z0-9-]*$/.test(c)) classes.add(c);
}

const cssClasses = new Set<string>();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) cssClasses.add(m[1]);

const missing = [...classes].filter((c) => !cssClasses.has(c));
assert('every class the panel renders exists in styles.css',
  missing.length === 0, `missing: ${missing.join(', ')}`);

/* ---------- the component's wiring ---------- */

// `ready` must come from the tested gate, not be re-derived inline where an
// error term can be forgotten again.
assert('the panel derives `ready` from isReady(...)',
  tsx.includes('isReady({'), 'ready is not sourced from the tested gate');
// The headline is called "Total On-Chain", so it must sum EVERY priced holding
// (`tokenValueUsd`), not just the USDT row — otherwise a tracked position is
// excluded from a figure presented as the total. Asserted on the call's own
// arguments so object shorthand still counts.
const totalCall = tsx.match(/onChainTotalUsd\(\{([^}]*)\}/)?.[1] ?? '';
assert('the headline total is fed the full token value',
  /\btokenValueUsd\b/.test(totalCall), `call args: ${totalCall.trim() || '(not found)'}`);
assert('the headline total is fed the unpriced-holding count',
  /\bunpricedHoldings\b/.test(totalCall), `call args: ${totalCall.trim() || '(not found)'}`);
assert('the headline total does NOT sum the USDT row alone',
  !/\busdtValue\b/.test(totalCall), 'still summing USDT only under a "total" label');
// Holdings the backend dropped (decimals unreadable) never reach `holdings`, so
// the count must come from the payload — a client-side filter cannot see them.
assert('the panel consumes the backend dropped-holding count',
  tsx.includes('snap.unpricedCount'), 'backend-dropped holdings are invisible to the guard');

// The USDT figure must come from the tested helper, not `usdt?.amount ?? 0`: the
// latter claims "0 USDT" when the backend dropped a holding it could not price,
// and that dropped holding may have been the USDT.
assert('the USDT amount is not the unguarded `?? 0`',
  !/usdt\?\.amount\s*\?\?\s*0/.test(tsx), 'still claims 0 USDT when holdings were dropped');
assert('the USDT amount is fed the dropped-holding count',
  /usdtAmountOf\([^)]*droppedHoldings/.test(tsx), 'USDT amount ignores backend-dropped holdings');

// The unknown-amount branch must be tested BEFORE the empty-wallet branch: with
// them swapped, a wallet whose USDT could not be read is told "belum ada — kirim
// USDT", i.e. to send money it already holds. Assert the order, not the prose.
const unknownIdx = tsx.indexOf('jumlah belum bisa dibaca');
const emptyIdx = tsx.indexOf('belum ada — kirim USDT');
assert('the "unknown amount" branch precedes the "none yet" branch',
  unknownIdx !== -1 && emptyIdx !== -1 && unknownIdx < emptyIdx,
  `unknown@${unknownIdx} empty@${emptyIdx} — a swapped pair tells the user to send USDT they hold`);

// A clipboard failure must NOT reach `err`, which feeds the `ready` gate — one
// shared channel meant a denied clipboard permission blanked the whole panel to
// "…" permanently. Assert the copy handler writes its own state and leaves `err`
// to load failures only.
const copyFn = tsx.match(/const copyAddress = async \(\) => \{([\s\S]*?)\n  \};/)?.[1] ?? '';
assert('the copy handler was found', copyFn.length > 0, 'could not locate copyAddress');
assert('a clipboard failure sets its own copyErr channel',
  copyFn.includes('setCopyErr('), 'copy failure does not use a separate error channel');
assert('a clipboard failure does NOT set the load-error state',
  !copyFn.includes('setErr('), 'copy failure still poisons the ready gate via setErr');
assert('the copy handler no longer points at a truncated address',
  !copyFn.includes('alamat di bawah'), 'still instructs manual copy from a truncated address');

// The "not displayed" note reassures that the missing tokens are merely unlisted
// — which implies the figure above is complete. It must not appear while the
// total is unknown (e.g. an unpriced gas coin), or it contradicts the "—".
assert('the reassuring note is suppressed while the total is unknown',
  tsx.includes('unpricedHoldings === 0 && total !== null'), 'note can render under an unknown total');

/* ---------- on-chain total ---------- */

check('total = priced gas coin + tracked tokens',
  onChainTotalUsd({ native: 0.1, nativeUsd: 3000, tokenValueUsd: 1204.5 }), 1504.5);
check('an UNPRICED gas coin with a balance is unknown, never zero',
  onChainTotalUsd({ native: 0.1, nativeUsd: null, tokenValueUsd: 1204.5 }), null);
check('a zero gas coin does not block a token-only total',
  onChainTotalUsd({ native: 0, nativeUsd: null, tokenValueUsd: 1204.5 }), 1204.5);
check('an empty wallet totals zero, not unknown',
  onChainTotalUsd({ native: 0, nativeUsd: 3000, tokenValueUsd: 0 }), 0);
check('a null token value counts as zero tokens, not a crash',
  onChainTotalUsd({ native: 0.1, nativeUsd: 3000, tokenValueUsd: null }), 300);
check('the total is rounded to cents',
  onChainTotalUsd({ native: 0.0001234, nativeUsd: 3000, tokenValueUsd: 0.005 }), 0.38);
check('a negative gas-coin price is not a valid price → unknown',
  onChainTotalUsd({ native: 0.1, nativeUsd: -3000, tokenValueUsd: 10 }), null);
// The backend's tokenValueUsd skips unpriced holdings, so a wallet with one has
// a partial sum — it must read as unknown, not as a smaller-but-confident total.
check('an unpriced token holding makes the total unknown, never a partial sum',
  onChainTotalUsd({ native: 0.1, nativeUsd: 3000, tokenValueUsd: 1000, unpricedHoldings: 1 }), null);
check('a wallet with no unpriced holdings still totals normally',
  onChainTotalUsd({ native: 0.1, nativeUsd: 3000, tokenValueUsd: 1000, unpricedHoldings: 0 }), 1300);
check('omitting the unpriced count defaults to none (back-compatible)',
  onChainTotalUsd({ native: 0.1, nativeUsd: 3000, tokenValueUsd: 1000 }), 1300);

/* ---------- the ready gate ---------- */

// The bug the reviewer caught: `ready` had no error term, so a FAILED load
// flipped it true and the panel told a wallet holding USDT that it held none.
const ok = { loading: false, err: '', isBound: true, chain: 'base', address: '0xabc' };
check('a clean load is ready', isReady(ok), true);
check('still loading is not ready', isReady({ ...ok, loading: true }), false);
check('a failed load is NOT ready — even though loading is false',
  isReady({ ...ok, err: 'Gagal memuat saldo on-chain' }), false);
check('an unbound wallet is not ready', isReady({ ...ok, isBound: false }), false);
check('an unsupported chain is not ready', isReady({ ...ok, chain: null }), false);
check('a missing address is not ready', isReady({ ...ok, address: null }), false);

/* ---------- gas state ---------- */

check('no gas coin → empty', gasState(0), 'empty');
check('below the floor → low', gasState(GAS_FLOOR / 2), 'low');
check('exactly at the floor → ok', gasState(GAS_FLOOR), 'ok');
check('comfortably funded → ok', gasState(0.5), 'ok');
check('an unread balance is unknown, not empty', gasState(null), 'unknown');
check('NaN is unknown, not empty', gasState(Number.NaN), 'unknown');

/* ---------- the USDT row ---------- */

const row = (symbol: string | null, amount: number, valueUsd: number | null = amount) =>
  ({ token: `0x${'1'.repeat(40)}`, symbol, amount, decimals: 6, priceUsd: 1, valueUsd });

check('the USDT row is picked out of the holdings',
  usdtRow([row('WETH', 1, 3000), row('USDT', 1204.5)])?.amount, 1204.5);
check('a missing USDT row means 0 USDT, not unknown',
  usdtRow([row('WETH', 1, 3000)]), null);
check('a USDT row priced null still reports its amount',
  usdtRow([row('USDT', 50, null)])?.amount, 50);
check('symbol matching is case-insensitive',
  usdtRow([row('usdt', 50)])?.amount, 50);
check('an empty holdings list yields no row', usdtRow([]), null);

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
