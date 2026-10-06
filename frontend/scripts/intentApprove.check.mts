// Verifies the MetaMask approve path: the order in which `approveIntent` claims
// an intent versus builds the swap, and the auto-approve selection rule.
//
// Two bugs this guards:
//
//  1. `approveIntent` called POST /api/real/swap-tx BEFORE claiming the intent
//     `active`, but the server refuses to build a swap for a non-active intent
//     (server.js returns 409). Every fresh intent 409'd, and the client's
//     "4xx is permanent" rule then added it to `skippedRef`, so the intent
//     silently vanished from the pending list. The claim MUST come first.
//
//  2. Auto-approve was display-only: nothing ever acted on the flag, so with it
//     ON a new intent never opened MetaMask. The provider now runs a loop, and
//     its selection rule is `nextAutoApprove` — pure and tested here.
//
// Run: npm run check  (from frontend/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nextAutoApprove } from '../src/lib/intents.ts';
import { chainIdHexFromKey, chainKeyFromId } from '../src/lib/evm.ts';

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

const ctx = read('../src/components/EvmWalletContext.tsx');
const modal = read('../src/components/RealWalletModal.tsx');

/* ---------- the 409 fix: claim BEFORE build ---------- */

const claimIdx = ctx.indexOf("realIntentStatus(intent.id, 'active'");
const buildIdx = ctx.indexOf('realSwapTx(');
assert('the claim call is present', claimIdx !== -1, "realIntentStatus(intent.id, 'active' not found");
assert('the build call is present', buildIdx !== -1, 'realSwapTx( not found');
assert('the intent is claimed BEFORE the swap is built',
  claimIdx !== -1 && buildIdx !== -1 && claimIdx < buildIdx,
  `claim@${claimIdx} build@${buildIdx} — building first makes the server 409 and the intent vanishes`);

/* ---------- a chain mismatch after the claim must reopen ---------- */

// The chain guard can now run before the claim (no server call), but a mismatch
// discovered after the build leaves the intent `active`; the catch branch must
// release it or it strands until the 10-minute TTL sweep.
const mismatchBranch = ctx.match(/if \(e instanceof ChainMismatchError\) \{([\s\S]*?)\n      \} else if/)?.[1] ?? '';
assert('the ChainMismatchError branch was found', mismatchBranch.length > 0, 'could not locate the branch');
assert('a post-claim chain mismatch reopens the intent',
  /realIntentStatus\(intent\.id,\s*'open'/.test(mismatchBranch),
  'the intent stays active until the TTL sweep');

/* ---------- the dead-cooldown regression ---------- */

// `cooldownRef` was written but never read, so the guard did nothing. The
// auto-approve selector is what reads it now; assert the read exists.
assert('the cooldown map is actually read by the selector',
  /cooldownUntil:\s*cooldownRef\.current/.test(ctx),
  'cooldownRef is written but never read — a transient failure re-fires immediately');

/* ---------- a broadcast tx is never auto-retried ---------- */

// The `sentHash` branch must also skip locally: if the `done` call fails and the
// server later sweeps the intent back to `open`, the auto-approve loop would
// rebuild and re-send the SAME trade — a real double-spend. Assert the branch
// adds the id to `skippedRef` BEFORE its early return.
const sentBranch = ctx.match(/\} else if \(sentHash\) \{([\s\S]*?)return;/)?.[1] ?? '';
assert('the already-broadcast branch was found', sentBranch.length > 0, 'could not locate the sentHash branch');
assert('a broadcast-but-unconfirmed tx is skipped locally (no re-send)',
  /skippedRef\.current\.add\(intent\.id\)/.test(sentBranch),
  'the auto-approve loop could re-send a tx that was already broadcast');

/* ---------- a resolved chain mismatch clears itself ---------- */

// The auto-approve effect bails while `chainMismatch` is set. That flag is
// cleared by the in-app switch button, but the user can also switch networks
// inside MetaMask — that only updates `chainId`. Without an effect that clears
// the mismatch once the wallet reaches the wanted chain, auto-approve would
// stay bailed forever after a manual network switch.
const clearIdx = ctx.indexOf('chainId === chainMismatch.wanted');
assert('a chain mismatch clears once the wallet reaches the wanted chain',
  clearIdx !== -1, 'auto-approve stays bailed after a manual MetaMask network switch');
assert('clearing the mismatch also drops the stale error banner',
  clearIdx !== -1 && /chainId === chainMismatch\.wanted[\s\S]{0,200}setApproveError\(''\)/.test(ctx),
  'the banner would keep naming the wrong chain after it was fixed');

/* ---------- a rate-limited build is retried, not dropped ---------- */

// `quote`, `swap-tx` and `manual-intent` share ONE server-side rate-limit bucket,
// so browsing quotes can 429 the swap build. A blanket "4xx is permanent" rule
// would skip the intent forever with no UI path to un-skip it — 429 must be
// excluded from the permanent set.
assert('429 is excluded from the permanent-4xx skip',
  /status\s*!==\s*429/.test(ctx), 'a rate-limited build is skipped permanently and never retried');

/* ---------- the approve leg is allow-listed too ---------- */

// The swap's `to` allow-list does NOT cover the approve leg. A spoofed response
// could name an attacker spender while `to` still passed, and MetaMask would
// show a plausible "Approve USDT" prompt for a drainable grant. Assert the
// spender is checked against the router before the approve is sent.
const approveIdx = ctx.indexOf('built.needsApproval && built.approveSpender');
assert('the approve-leg block was found', approveIdx !== -1, 'could not locate the needsApproval block');
const approveBlock = ctx.slice(approveIdx, approveIdx + 1400);
assert('the approve spender is checked against the router allow-list',
  /approveSpender\)\.toLowerCase\(\)\s*!==\s*ALLOWED_ROUTER/.test(approveBlock),
  'a spoofed spender would be approved — the swap `to` check does not cover it');
assert('an unlimited approve is refused',
  /MAX_UINT256/.test(approveBlock), 'an infinite allowance could be granted');
assert('the approve token address is validated before use',
  /ADDRESS_RE\.test\(\s*String\(approveToken\)/.test(approveBlock),
  'a malformed token address would be sent to MetaMask');

// C2: pad32 must refuse an over-long value rather than silently shifting the
// ABI word alignment, and encodeApprove must validate the spender shape.
assert('pad32 refuses a value that does not fit one ABI word',
  /body\.length > 64/.test(ctx), 'an over-long amount would misalign the calldata');
assert('encodeApprove validates the spender is a real address',
  /ADDRESS_RE\.test\(spender\)/.test(ctx), 'a 63-char spender would be padded into a different address');

/* ---------- the swap calldata is validated ---------- */

assert('the swap calldata is validated as hex before signing',
  /\.test\(String\(built\.data\)\)/.test(ctx),
  'non-hex swap data would reach MetaMask unvalidated');

/* ---------- an insecure origin cannot drive the wallet ---------- */

// Over http (or a tunnel) a network attacker can rewrite the app's own JS, so
// a signature there is not provably the tx this code built. The guard must run
// before the in-flight lock is taken, i.e. before any wallet interaction.
const insecureIdx = ctx.indexOf('if (isInsecureOrigin())');
const lockIdx = ctx.indexOf('runningRef.current = true;');
assert('an insecure origin blocks execution',
  insecureIdx !== -1, 'real funds could be signed over http where the app JS can be rewritten');
assert('the insecure-origin guard runs before the in-flight lock',
  insecureIdx !== -1 && lockIdx !== -1 && insecureIdx < lockIdx,
  `guard@${insecureIdx} lock@${lockIdx}`);

/* ---------- an ambiguous send is never auto-retried ---------- */

// If the swap is handed to MetaMask and the send throws without a hash (RPC
// response lost), we cannot prove nothing broadcast. Marking it done and
// skipping is the only safe call: re-opening would re-sign the same trade.
const submittedSet = ctx.indexOf('swapSubmitted = true;');
const swapSendIdx = ctx.indexOf('const txHash = await sendTransaction({');
assert('the swap is flagged submitted before the send',
  submittedSet !== -1 && swapSendIdx !== -1 && submittedSet < swapSendIdx,
  `flag@${submittedSet} send@${swapSendIdx} — a lost RPC response would leave no trace`);
const submittedBranch = ctx.match(/\} else if \(swapSubmitted\) \{([\s\S]*?)\n      \} else \{/)?.[1] ?? '';
assert('the ambiguous-send branch was found', submittedBranch.length > 0, 'could not locate it');
assert('an ambiguous send is marked done, not reopened',
  /realIntentStatus\(intent\.id,\s*'done'/.test(submittedBranch),
  'an unconfirmed broadcast could be re-sent — a double-spend');
assert('an ambiguous send is skipped locally',
  /skippedRef\.current\.add\(intent\.id\)/.test(submittedBranch),
  'the auto-approve loop could re-select it');
assert('the user-rejection branch precedes the ambiguous-send branch',
  ctx.indexOf('rejected the request') !== -1
    && ctx.indexOf('rejected the request') < ctx.indexOf('} else if (swapSubmitted)'),
  'a user rejection would be mistaken for a broadcast');
assert('a non-numeric approve amount is refused, not retried',
  /Jumlah approve bukan angka/.test(ctx), 'a malformed amount would loop in the transient path');

/* ---------- the auto-approve effect exists and is gated ---------- */

const effectIdx = ctx.indexOf('nextAutoApprove(');
assert('the provider runs the auto-approve selector', effectIdx !== -1, 'no nextAutoApprove( call');
// The effect must be gated on the flag, and must pass the wallet's CURRENT chain
// so a wrong-chain intent is never selected (one mismatch must not freeze the
// whole loop, and a mismatch must not spam MetaMask on the wrong network).
const effect = ctx.slice(Math.max(0, effectIdx - 800), effectIdx + 400);
assert('auto-approve is gated on the autoApprove flag',
  /\bautoApprove\b/.test(effect), 'the selector runs even when auto-approve is off');
assert('the selector is fed the wallet\'s current chain',
  /currentChainKey\s*:/.test(effect), 'a wrong-chain intent could be selected, or one mismatch freezes the loop');
assert('the current chain is derived from the live chainId',
  /chainKeyFromId\(\s*chainId\s*\)/.test(effect), 'the selector is not chain-aware');

/* ---------- copy: auto-approve is not a bot signature ---------- */

assert('the modal no longer claims the bot signs on its own',
  !modal.includes('Bot menandatangani'), 'stale "bot signs without asking" copy remains');
assert('the modal no longer labels execution "Approve otomatis oleh bot"',
  !modal.includes('Approve otomatis oleh bot'), 'stale "executed by bot" copy remains');

/* ---------- chain key → hex round-trip ---------- */

// The pre-claim chain guard compares the wallet's hex chain id to the intent's
// stored chain KEY. If a supported key ever fails to resolve, the guard would
// throw "chain tidak dikenal" and refuse every trade — so every key the backend
// accepts must round-trip.
const SUPPORTED = ['base', 'ethereum', 'arbitrum', 'bsc', 'optimism', 'polygon', 'avalanche'];
for (const key of SUPPORTED) {
  const hex = chainIdHexFromKey(key);
  check(`${key} resolves to a hex chain id that round-trips`,
    hex !== null && chainKeyFromId(hex) === key, true);
}
check('an unknown chain key resolves to null (guard fails closed)',
  chainIdHexFromKey('dogechain'), null);
// Prototype keys must not resolve through Object.prototype — `constructor` and
// `__proto__` would otherwise return a function/object, defeating the caller's
// `!wantChain` fail-closed guard and crashing chainLabel downstream.
check('an inherited prototype key resolves to null, not a function',
  chainIdHexFromKey('constructor'), null);
check('__proto__ resolves to null, not an object',
  chainIdHexFromKey('__proto__'), null);
check('toString resolves to null', chainIdHexFromKey('toString'), null);

/* ---------- nextAutoApprove behaviour ---------- */

const empty = {
  skipped: new Set<string>(),
  cooldownUntil: new Map<string, number>(),
  now: 1000,
  currentChainKey: 'base',
};
const open = (id: string, chainId = 'base') => ({ id, status: 'open', chainId });

check('picks the first open intent',
  nextAutoApprove([open('a'), open('b')], empty)?.id, 'a');
check('skips an intent that is not open',
  nextAutoApprove([{ id: 'a', status: 'active', chainId: 'base' }, open('b')], empty)?.id, 'b');
check('skips a skipped intent',
  nextAutoApprove([open('a'), open('b')], { ...empty, skipped: new Set(['a']) })?.id, 'b');
check('skips an intent still in cooldown',
  nextAutoApprove([open('a'), open('b')], { ...empty, cooldownUntil: new Map([['a', 2000]]) })?.id, 'b');
check('an expired cooldown is eligible again',
  nextAutoApprove([open('a')], { ...empty, cooldownUntil: new Map([['a', 500]]) })?.id, 'a');
check('a cooldown boundary equal to now is eligible',
  nextAutoApprove([open('a')], { ...empty, cooldownUntil: new Map([['a', 1000]]) })?.id, 'a');
check('nothing eligible is null',
  nextAutoApprove([{ id: 'a', status: 'done', chainId: 'base' }], empty), null);
check('an empty list is null', nextAutoApprove([], empty), null);
check('returns at most ONE intent per call',
  nextAutoApprove([open('a'), open('b'), open('c')], empty)?.id, 'a');

// Chain-awareness: the loop must only ever drive an intent for the chain the
// wallet is actually on. A wrong-chain intent must be skipped (not selected and
// then refused), so one mismatch cannot freeze the loop for the others.
check('skips an intent on another chain',
  nextAutoApprove([open('a', 'ethereum'), open('b', 'base')], empty)?.id, 'b');
check('a wrong-chain intent alone selects nothing',
  nextAutoApprove([open('a', 'ethereum')], empty), null);
check('an unreadable chain selects nothing (fail closed)',
  nextAutoApprove([open('a')], { ...empty, currentChainKey: null }), null);
// An unsupported chain reaches the selector as `null` (the caller maps the hex
// id through chainKeyFromId, which returns null for a chain it does not know).
// The null gate must fire before the per-intent filter, so even an intent whose
// key is spelled 'base' is refused when the wallet's chain is unreadable.
check('an unsupported chain (caller passes null) selects nothing',
  nextAutoApprove([open('a', 'base'), open('b', 'ethereum')], { ...empty, currentChainKey: null }), null);
check('the chain filter does not mask a later eligible intent',
  nextAutoApprove([open('a', 'ethereum'), open('b', 'bsc'), open('c', 'base')], empty)?.id, 'c');

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
