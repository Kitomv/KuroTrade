// Verifies the login screen: the pure helpers that drive its copy, and the
// structural guarantees the page must keep.
//
// The page was rebuilt around the app's own terminal language (warm ink, IBM
// Plex, one amber accent, hairline rules) instead of a generic centered card,
// and then narrowed to a single entry path: an admin issues the account, so
// there is no self-registration and no wallet login. Both of those are exactly
// the kind of change that quietly drops an accessibility association or leaves
// a dead wallet branch behind, so both are pinned here.
//
// Run: npm run check  (from frontend/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vaultLabel, credentialError } from '../src/lib/loginView.ts';

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

check('an idle vault button reads "Masuk"', vaultLabel(false), 'Masuk');
check('a login in flight says so', vaultLabel(true), 'Melogin…');
// The label is the ONLY feedback that the click landed — the button is disabled
// while pending, so it must not read "Masuk" during the wait.
check('a pending vault never reads as idle', vaultLabel(true) === vaultLabel(false), false);

/* ---------- credentialError ---------- */

check('an empty username is refused before any request', credentialError('', 'password123'), 'Username wajib diisi');
check('a whitespace-only username is refused too', credentialError('   ', 'password123'), 'Username wajib diisi');
check('an empty password is refused', credentialError('someone', ''), 'Password wajib diisi');
check('a filled form passes the guard', credentialError('someone', 'password123'), null);
// Username is checked first: telling someone their password is missing when
// they never typed a username sends them to fix the wrong field.
check('the username is reported before the password',
  credentialError('', ''), 'Username wajib diisi');

/* ---------- the page has exactly one way in ---------- */

assert('the password form still submits', /onSubmit=\{handleSubmit\}/.test(page),
  'the form lost its submit handler');
assert('the credential guard runs before the request', /credentialError\(username, password\)/.test(page),
  'the form would fire a request for an empty field');
// The wallet-login path was removed on purpose: access is granted by an admin,
// so a wallet must not be able to mint an account by signing a message.
assert('the wallet login path is gone', !/handleWalletLogin|subscribeProviders|window\.ethereum/.test(page),
  'a wallet entry point survived the removal — anyone could still self-provision');
assert('no wallet sign-in affordance survives', !/Masuk dengan MetaMask/.test(page),
  'the removed wallet button is still offered on the login screen');
assert('the page says who can create an account', /Akun dibuat oleh admin/.test(page),
  'the only route to an account is not stated anywhere on the screen');

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

for (const cls of ['login-page', 'login-frame', 'login-halo', 'login-submit']) {
  assert(`styles.css defines .${cls}`, new RegExp(`\\.${cls}\\b`).test(css),
    `no rule for .${cls} — the markup would render unstyled`);
}
// Dead rules from the wallet-login era: leaving them is how a removed path
// quietly comes back as a half-styled button someone wires up again.
for (const cls of ['login-or', 'login-wallet', 'login-wallet-missing']) {
  assert(`the retired .${cls} rules are gone`, !new RegExp(`\\.${cls}\\b`).test(css),
    `.${cls} still has a rule but nothing renders it`);
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
