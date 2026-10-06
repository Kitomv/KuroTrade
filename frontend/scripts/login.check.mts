// Verifies the login screen: the two pure helpers that drive its copy, and the
// structural guarantees the page must keep.
//
// The page was rebuilt around the app's own terminal language (warm ink, IBM
// Plex, one amber accent, hairline rules) instead of a generic centered card.
// A restyle is exactly the kind of change that quietly drops an accessibility
// association or a re-check, so those are pinned here.
//
// Run: npm run check  (from frontend/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vaultLabel, walletLabel, rejectionMessage } from '../src/lib/loginView.ts';

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

const page = read('../src/pages/Login.tsx');
const css = read('../src/styles.css');

/* ---------- vaultLabel ---------- */

check('an idle vault button reads "Masuk"', vaultLabel(null), 'Masuk');
check('a vault login in flight says so',
  vaultLabel({ kind: 'password', step: 'login' }), 'Melogin…');
// The wallet path must never borrow the password label: the two buttons sit on
// the same screen and a wrong one makes it look like the click went nowhere.
check('a wallet login never borrows the vault label',
  vaultLabel({ kind: 'wallet', step: 'sign' }), 'Masuk');

/* ---------- walletLabel ---------- */

check('an idle wallet button names the method',
  walletLabel(null), 'Masuk dengan MetaMask');
check('opening MetaMask is not called "signing"',
  walletLabel({ kind: 'wallet', step: 'connect' }), 'Buka MetaMask…');
check('the signing step is named', walletLabel({ kind: 'wallet', step: 'sign' }), 'Tanda tangani di MetaMask…');
check('the server check is named', walletLabel({ kind: 'wallet', step: 'verify' }), 'Memverifikasi…');
// Symmetry with vaultLabel: neither button may wear the other's label.
check('a vault login never borrows the wallet label',
  walletLabel({ kind: 'password', step: 'login' }), 'Masuk dengan MetaMask');
check('the two idle labels differ',
  vaultLabel(null) === walletLabel(null), false);

/* ---------- rejectionMessage ---------- */

check('a MetaMask rejection is translated',
  rejectionMessage(new Error('User rejected the request.')), 'Signature dibatalkan di MetaMask');
check('a lowercase "user denied" is translated too',
  rejectionMessage(new Error('user denied transaction')), 'Signature dibatalkan di MetaMask');
check('the generic MetaMask failure names the extension conflict',
  /Nonaktifkan ekstensi wallet lain/.test(
    rejectionMessage(new Error('Unexpected error'))), true);
check('an unknown failure passes through verbatim',
  rejectionMessage(new Error('RPC down')), 'RPC down');
check('a thrown string still yields a message',
  rejectionMessage('boom'), 'boom');
check('a non-Error, non-string throw falls back',
  rejectionMessage({ weird: true }), 'Login wallet gagal');
// A rejection must NOT be reported as an extension conflict — that message
// tells the user to disable their other wallets, which is the wrong fix.
check('a rejection is not mistaken for the extension conflict',
  /Nonaktifkan ekstensi/.test(rejectionMessage(new Error('User rejected the request'))), false);

/* ---------- the page keeps its two entry paths ---------- */

assert('the password form still submits', /onSubmit=\{handleSubmit\}/.test(page),
  'the vault form lost its submit handler');
assert('the wallet path is still wired', /onClick=\{handleWalletLogin\}/.test(page),
  'the MetaMask button lost its handler');
assert('a wallet installed late is still picked up', /subscribeProviders\(/.test(page),
  'the page would stay on "not detected" until a reload — a dead end');

/* ---------- accessibility the restyle must not drop ---------- */

assert('the error region is announced', /role="alert"/.test(page),
  'a failed login would be silent to a screen reader');
assert('the heading is referenced by the section', /aria-labelledby="login-title"/.test(page),
  'the screen has no accessible name');
assert('the heading exists', /id="login-title"/.test(page), 'aria-labelledby points at nothing');
assert('the username label is explicitly associated',
  /htmlFor="login-username"/.test(page) && /id="login-username"/.test(page),
  'a label not tied to its input is not announced');
assert('the password label is explicitly associated',
  /htmlFor="login-password"/.test(page) && /id="login-password"/.test(page),
  'a label not tied to its input is not announced');
assert('the password toggle reports its state', /aria-pressed=/.test(page),
  'the eye button is a toggle and must expose whether the password is shown');
assert('the decorative glow is hidden from assistive tech',
  /login-halo"\s+aria-hidden="true"/.test(page),
  'the halo is decoration and would otherwise be read out');

/* ---------- the page belongs to this app, not to a template ---------- */

// `.card-neon` is documented in styles.css as vestigial (the animated ring is
// gone). A login card built on it would be styling against a dead class.
assert('the page no longer builds on the retired card class',
  !page.includes('CardNeon'), 'CardNeon is vestigial — styles.css says the neon ring is gone');
assert('the page uses the login vocabulary', /className="login-page"/.test(page),
  'no login-page root');
assert('the brand mark is unchanged', /DEX Trade/.test(page), 'the product name drifted');

/* ---------- the stylesheet carries the design ---------- */

for (const cls of ['login-page', 'login-frame', 'login-halo', 'login-submit', 'login-wallet']) {
  assert(`styles.css defines .${cls}`, new RegExp(`\\.${cls}\\b`).test(css),
    `no rule for .${cls} — the markup would render unstyled`);
}
// The app's type is the design; a login that silently fell back to a system
// stack would no longer look like the same product.
assert('the app typeface is still loaded', /IBM\+Plex/.test(css), 'the IBM Plex import is gone');
assert('reduced motion is still honoured', /prefers-reduced-motion/.test(css),
  'the global reduced-motion block was removed');

// Scoped styles must win on specificity, not on !important — an !important in
// the login block is the tell that the cascade was fought rather than designed.
const block = css.slice(css.indexOf('.login-page'), css.indexOf('prefers-reduced-motion'));
assert('the login block exists in the stylesheet', block.length > 200,
  'the .login-page block was not found');
assert('the login styles avoid !important', !block.includes('!important'),
  'an !important in the login block means the cascade was fought, not designed');

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
