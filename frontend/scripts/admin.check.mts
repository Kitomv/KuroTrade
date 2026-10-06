// Verifies the admin surface — the page that adds users, the API client it
// calls, and the fail-closed role gate that keeps everyone else out of it.
//
// Access is now admin-issued: the login screen says so, and this page is where
// that promise is kept. Three properties matter and are pinned here:
//
//   1. The client-side validators mirror the SERVER's rules. A form that
//      accepts what the API rejects makes the API look broken.
//   2. The role gate fails closed everywhere — an absent, unknown, or stale
//      role must never reveal the page or the nav entry.
//   3. The wallet-login path is really gone from the API client, not just
//      hidden in the UI (anyone can still call the endpoints directly).
//
// Run: npm run check  (from frontend/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newUserError, passwordError, USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN } from '../src/lib/adminView.ts';

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

const adminPage = read('../src/pages/Admin.tsx');
const client = read('../src/api/client.ts');
const app = read('../src/App.tsx');
const sidebar = read('../src/components/Sidebar.tsx');
const icons = read('../src/components/Icons.tsx');
// The server is the authority these validators copy — read it so the copy
// cannot drift silently.
const server = read('../../backend/src/server.js');

/* ---------- newUserError: the happy path and each rejection ---------- */

check('a valid new account passes', newUserError('trader.one', 'password123'), null);
check('an empty username is refused', newUserError('', 'password123'), 'Username wajib diisi');
check('a whitespace-only username is refused', newUserError('   ', 'password123'), 'Username wajib diisi');
check('a too-short username is refused', newUserError('ab', 'password123'), 'Username harus 3–32 karakter');
check('a too-long username is refused', newUserError('a'.repeat(33), 'password123'), 'Username harus 3–32 karakter');
check('the shortest allowed username passes', newUserError('abc', 'password123'), null);
check('the longest allowed username passes', newUserError('a'.repeat(32), 'password123'), null);
// The character class is the server's, character for character: a space or a
// slash would be stored and then be untypeable/unsafe in a URL.
check('a username with a space is refused',
  newUserError('trader one', 'password123'),
  'Username hanya boleh huruf, angka, titik, garis bawah, dan strip');
check('a username with a slash is refused',
  newUserError('trader/one', 'password123'),
  'Username hanya boleh huruf, angka, titik, garis bawah, dan strip');
check('dots, underscores, and dashes are allowed',
  newUserError('a.b_c-d', 'password123'), null);
check('a valid username with a short password reports the password',
  newUserError('trader.one', 'short'), 'Password minimal 8 karakter');
// Username first: fixing the password would not get past the API either.
check('the username is reported before the password',
  newUserError('', ''), 'Username wajib diisi');

/* ---------- passwordError ---------- */

check('an empty password is refused', passwordError(''), 'Password wajib diisi');
check('a seven-character password is refused', passwordError('1234567'), 'Password minimal 8 karakter');
check('an eight-character password passes', passwordError('12345678'), null);

/* ---------- the copy mirrors the server's bounds ---------- */

// If the server's numbers change and these do not, the form starts accepting
// (or rejecting) the wrong accounts. Pin the literals against the source.
assert('the server still enforces 3–32 character usernames',
  /name\.length < 3 \|\| name\.length > 32/.test(server),
  'the server bound changed — adminView.ts must follow it');
assert('the server still enforces an 8-character minimum password',
  /String\(password\)\.length < 8/.test(server),
  'the server password bound changed — adminView.ts must follow it');
assert('the client and server use the same username character class',
  server.includes('/^[A-Za-z0-9._-]+$/'),
  'the server character class changed — adminView.ts must follow it');
check('the client constants match the server literals',
  [USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN], [3, 32, 8]);

/* ---------- the API client carries the three admin calls ---------- */

assert('the client lists accounts', /adminUsers: \(\) => req<\{ users: AdminUserRow\[\] \}>/.test(client),
  'no adminUsers method — the page cannot load the list');
assert('the client creates accounts', /adminCreateUser: \(data: \{ username: string; password: string \}\)/.test(client),
  'no adminCreateUser method — the whole feature is missing');
assert('the client resets passwords', /adminSetPassword: \(id: string, password: string\)/.test(client),
  'no adminSetPassword method');
// The reset must go through the id path param, encoded — a raw id in a URL is
// how a crafted id escapes its segment.
assert('the reset path is URL-encoded', /admin\/users\/\$\{encodeURIComponent\(id\)\}\/password/.test(client),
  'the id is interpolated into the URL unencoded');
// Field declarations only — the doc comment above the interface is allowed to
// name what the API must never send.
const rowType = client.slice(client.indexOf('export interface AdminUserRow'), client.indexOf('export interface AdminUserRow') + 700);
assert('the admin row type never carries credential material',
  !/\b(hash|salt)\s*[?:]/.test(rowType),
  'AdminUserRow grew a hash/salt field — the API must never send one');

/* ---------- the wallet-login path is gone from the client ---------- */

for (const dead of ['loginWallet', 'loginWalletChallenge', 'WalletLoginResult']) {
  assert(`the client no longer exposes ${dead}`, !client.includes(dead),
    `${dead} is still callable — the wallet could still mint an account`);
}
// Binding must survive the removal: it is how a user proves control of an
// address to trade real funds.
assert('wallet BINDING survives the login removal',
  /bindMessage: \(address: string\)/.test(client) && /bindWallet: \(data:/.test(client),
  'the bind path was removed along with the login path — real trading would break');

/* ---------- the Admin page ---------- */

assert('the page loads the account list', /api\.adminUsers\(\)/.test(adminPage),
  'the page never fetches accounts');
assert('the page creates accounts', /api\.adminCreateUser\(/.test(adminPage),
  'the add-user form is not wired');
assert('the page resets passwords', /api\.adminSetPassword\(/.test(adminPage),
  'the reset action is not wired');
assert('the form validates before it submits',
  /newUserError\(name, pw\)/.test(adminPage),
  'the form would fire a request the server will reject');
assert('the form refuses to submit while busy', /disabled=\{busy\}/.test(adminPage),
  'double-submit would create a duplicate account request');
assert('the reset validates its password', /passwordError\(resetPw\)/.test(adminPage),
  'the reset would send a password the server rejects');
// Scoped to the failure branch: `role="alert"` also marks the two form errors,
// so a bare presence test passes even if the list branch loses its alert.
const failAt = adminPage.indexOf('loadFailed ? (');
const failBranch = failAt < 0 ? '' : adminPage.slice(failAt, failAt + 300);
assert('the list failure is surfaced, not swallowed', /role="alert"/.test(failBranch),
  'a 403/failed load would render an empty table and look like "no users"');
// An admin resetting their own password would revoke their own session
// (destroyOtherSessions) — the button must not be offered for the current user.
assert('a self reset is not offered', /isSelf/.test(adminPage) && /!isSelf &&/.test(adminPage),
  'an admin can trigger a reset on themselves and get logged out');
assert('the page says how a first admin exists',
  /konfigurasi server|env/i.test(adminPage),
  'nothing explains that admin is not grantable from the UI');

/* ---------- the role gate fails closed ---------- */

// The initial value must be the non-privileged one: a stale or missing role
// must never reveal the page, not even for a frame.
assert('the app defaults to the user role', /useState<UserRole>\('user'\)/.test(app),
  'the app starts with a privileged role — a fail-open gate');
assert('the admin page is gated on the role',
  /page === 'admin' && role === 'admin'/.test(app),
  'the Admin page renders for any role');
assert('navigation to admin is refused for non-admins',
  /if \(p === 'admin' && role !== 'admin'\) return;/.test(app),
  'onNavigate could still switch to the admin page');
assert('the role comes from /api/me, not storage', /setRole\(me\.role\)/.test(app),
  'the role is not refreshed from the server');
assert('the role is not persisted to localStorage', !/trading_role/.test(app),
  'a cached role could outlive a demotion');
// Scoped to the handler body: `setRole('user')` also appears in the 401 path,
// so a bare presence test would pass even after the logout site lost its reset.
const logoutAt = app.indexOf('const handleLogout');
const logoutBody = logoutAt < 0 ? '' : app.slice(logoutAt, logoutAt + 500);
assert('logout clears the role', logoutBody.includes("setRole('user')"),
  'the next sign-in on this browser could inherit the admin role');
assert('a 401 clears the role', app.slice(app.indexOf("on401"), app.indexOf("on401") + 200).includes("setRole('user')"),
  'an expired session could keep the admin surface mounted');

/* ---------- the nav entry is gated the same way ---------- */

assert('the admin nav entry is marked admin-only', /adminOnly: true/.test(sidebar),
  'the entry is not flagged, so the filter below cannot exclude it');
assert('the nav filters fail closed', /role === 'admin' \? nav : nav\.filter\(\(n\) => !n\.adminOnly\)/.test(sidebar),
  'the nav does not filter — every user would see Admin');
// Both the rail and the mobile "Lainnya" modal must render the FILTERED list.
// The modal is the one that leaks: it is a second copy of the same markup, and
// any map over the raw `nav` (including a `nav.filter(...).map(...)`) puts the
// Admin entry back on every phone. Pin the map call sites themselves.
const mapLines = sidebar.split('\n').filter((l) => l.includes('.map('));
assert('every nav list renders the filtered items',
  mapLines.length === 2 && mapLines.every((l) => l.includes('items.map(')),
  `expected exactly 2 map sites, both over \`items\` — got ${JSON.stringify(mapLines.map((l) => l.trim()))}`);
assert('the nav entry is secondary (mobile reaches it via Lainnya)', /page: 'admin'[\s\S]{0,120}secondary: true/.test(sidebar),
  'the entry would be hidden on mobile with no route to it');
assert('the admin icon exists', /export const IconUserPlus/.test(icons),
  'the nav imports an icon that does not exist — the build would fail');

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
