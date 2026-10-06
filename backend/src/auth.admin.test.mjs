// Role and admin-account tests: who counts as an admin, how the first one is
// seeded, and what an admin can create.
//
// The security property under test is fail-closed: a record with no role, a
// role the code does not know, and a role inherited from Object.prototype all
// read as 'user'. Only the exact string 'admin' grants admin.
// Run: node --test backend/src/auth.admin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// PERSIST_DATA_DIR must be set before the module graph loads: persistence.js
// resolves DATA_DIR at module-evaluation time, and ESM hoists imports above
// statements. Without this the test writes real credentials into backend/data.
const TEMP_DIR = join(tmpdir(), `admin-auth-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const auth = await import('./auth.js');
const {
  createUser, verifyUser, getUserById, roleOf, isAdmin, listAccounts,
  setUserPassword, seedAdminFromEnv, listUsers,
} = auth;

let seq = 0;
const fresh = () => `adm_${process.pid}_${seq++}`;
const usersFile = join(TEMP_DIR, 'users.json');
const readUsers = () => JSON.parse(readFileSync(usersFile, 'utf8'));
const writeUsers = (u) => writeFileSync(usersFile, JSON.stringify(u, null, 2), 'utf8');

/* ---------------- fail-closed role resolution ---------------- */

test('an unknown or missing role reads as user, never admin', () => {
  for (const bad of [undefined, null, '', 'ADMIN', 'Admin', 'superuser', 1, true, {}, []]) {
    assert.equal(roleOf({ role: bad }), 'user', `role ${JSON.stringify(bad)} must not grant admin`);
  }
  assert.equal(roleOf({}), 'user', 'a record written before roles existed reads as user');
  assert.equal(roleOf(null), 'user');
  assert.equal(roleOf(undefined), 'user');
});

test('only the exact string admin grants admin', () => {
  assert.equal(roleOf({ role: 'admin' }), 'admin');
  assert.equal(roleOf({ role: 'user' }), 'user');
});

test('a prototype-polluted role cannot grant admin', () => {
  // The codebase has hit this class of bug before (see lib/evm.ts chain map).
  // roleOf reads the own value; an inherited 'admin' must not count.
  const polluted = Object.create({ role: 'admin' });
  polluted.username = 'nobody';
  assert.equal(roleOf(polluted), 'user', 'an inherited role must not be honoured');
  // And a literal __proto__ key in stored JSON is just an own property.
  const parsed = JSON.parse('{"__proto__":{"role":"admin"}}');
  assert.equal(roleOf(parsed), 'user');
});

/* ---------------- createUser carries and normalises the role ---------------- */

test('createUser defaults to a regular user', () => {
  const u = createUser(fresh(), 'password12345');
  assert.equal(u.role, 'user');
  assert.equal(isAdmin(u.id), false);
});

test('createUser refuses to store a role the reader would not honour', () => {
  const u = createUser(fresh(), 'password12345', 'root');
  assert.equal(u.role, 'user', 'an unknown role is normalised on write, not persisted');
  assert.equal(readUsers().find((x) => x.id === u.id).role, 'user');
});

test('an admin can be created explicitly', () => {
  const u = createUser(fresh(), 'password12345', 'admin');
  assert.equal(u.role, 'admin');
  assert.equal(isAdmin(u.id), true);
});

test('createUser refuses an empty or non-string username or password', () => {
  assert.equal(createUser('', 'password12345'), false);
  assert.equal(createUser(null, 'password12345'), false);
  assert.equal(createUser(42, 'password12345'), false);
  assert.equal(createUser(fresh(), ''), false);
  assert.equal(createUser(fresh(), null), false);
});

test('a created user can log in and is not an admin by default', () => {
  const name = fresh();
  const created = createUser(name, 'password12345');
  const verified = verifyUser(name, 'password12345');
  assert.equal(verified.id, created.id);
  assert.equal(roleOf(verified), 'user');
});

/* ---------------- the admin list never leaks credentials ---------------- */

test('listAccounts exposes role and hasPassword, never hash or salt', () => {
  const name = fresh();
  const u = createUser(name, 'password12345', 'admin');
  const row = listAccounts().find((r) => r.id === u.id);

  assert.equal(row.username, name);
  assert.equal(row.role, 'admin');
  assert.equal(row.hasPassword, true, 'a password account is reported as having one');
  assert.equal(row.hash, undefined, 'no hash');
  assert.equal(row.salt, undefined, 'no salt');
  assert.equal(row.password, undefined, 'no plaintext');
});

test('listAccounts reports an account with no password material', () => {
  // A legacy wallet-only record (created before wallet login was removed).
  const legacy = { id: `legacy_${process.pid}`, username: null, address: '0xabc', createdAt: 1 };
  writeUsers([...readUsers(), legacy]);
  const row = listAccounts().find((r) => r.id === legacy.id);
  assert.equal(row.hasPassword, false);
  assert.equal(row.role, 'user', 'no role field reads as user');
});

test('listAccounts is newest first', () => {
  const rows = listAccounts();
  for (let i = 1; i < rows.length; i++) {
    assert.ok((rows[i - 1].createdAt ?? 0) >= (rows[i].createdAt ?? 0), 'newest first');
  }
});

/* ---------------- a corrupt store must not be clobbered ---------------- */

test('an unreadable users.json refuses the write instead of replacing it', () => {
  // A truncated file (crash mid-write, full disk, hand-edit) must NOT read as
  // "no users". The next write — now most likely the admin add-user route —
  // would otherwise overwrite every account with a single record and report
  // 201 Created, orphaning every per-user state file keyed by the lost ids.
  const backup = readUsers();
  try {
    writeUsers(backup); // start from a known-good store
    writeFileSync(usersFile, '{"not":"an array"', 'utf8'); // truncated JSON
    assert.throws(() => createUser(fresh(), 'password12345'),
      /users\.json|corrupt|tidak bisa dibaca/i,
      'a create on an unreadable store must throw, not silently start over');
    // And the damaged bytes must still be there for recovery.
    assert.equal(readFileSync(usersFile, 'utf8'), '{"not":"an array"',
      'the unreadable file must not be overwritten');
  } finally {
    writeUsers(backup);
  }
});

test('a JSON document that is not an array is refused too', () => {
  // `{}` parses fine but is not a list; `.map` would throw a confusing
  // TypeError and a write would persist the object as the store.
  const backup = readUsers();
  try {
    writeUsers(backup);
    writeFileSync(usersFile, '{"users":[]}', 'utf8');
    assert.throws(() => createUser(fresh(), 'password12345'),
      /users\.json|corrupt|tidak bisa dibaca/i,
      'a non-array store must be refused, not treated as empty');
  } finally {
    writeUsers(backup);
  }
});

test('a missing users.json is still a legitimate fresh install', () => {
  // The distinction that makes the check safe: absent file = no accounts yet;
  // unreadable file = never silently empty.
  const backup = readUsers();
  try {
    rmSync(usersFile, { force: true });
    const u = createUser(fresh(), 'password12345');
    assert.ok(u, 'a genuinely missing store must still allow the first account');
  } finally {
    writeUsers(backup);
  }
});

test('boot survives a corrupt store — a bad file must not take the server down', () => {
  // Fail-closed must not mean fail-fatal: refusing the WRITE is the point, but
  // crashing the whole process at boot would take down market data and every
  // other user for one damaged file. The seed logs loudly and returns; the
  // store stays untouched and every read/write that needs it still throws.
  const backup = readUsers();
  try {
    writeFileSync(usersFile, '{"broken":', 'utf8');
    assert.doesNotThrow(() => seedAdminFromEnv(), 'the boot seed must not throw');
    assert.equal(readFileSync(usersFile, 'utf8'), '{"broken":', 'and must not touch the file');
  } finally {
    writeUsers(backup);
  }
});

test('the leaderboard list still carries no role', () => {
  // listUsers feeds the leaderboard; whether someone is an admin is not its
  // business, and adding it there would widen the public surface.
  const [row] = listUsers();
  assert.equal(row.role, undefined, 'listUsers must not start leaking roles');
});

/* ---------------- admin password reset ---------------- */

test('an admin can set a password on an account that had none', () => {
  const legacy = { id: `legacy2_${process.pid}`, username: `lg_${process.pid}`, address: '0xdef', createdAt: 2 };
  writeUsers([...readUsers(), legacy]);
  assert.equal(setUserPassword(legacy.id, 'brandnewpass1'), true);
  // The account can now log in — this is the only way a legacy record gets one.
  const verified = verifyUser(legacy.username, 'brandnewpass1');
  assert.equal(verified?.id, legacy.id);
});

test('an admin reset replaces the old password rather than adding to it', () => {
  const name = fresh();
  const u = createUser(name, 'oldpassword1');
  setUserPassword(u.id, 'newpassword1');
  assert.equal(verifyUser(name, 'oldpassword1'), null, 'the old password no longer works');
  assert.ok(verifyUser(name, 'newpassword1'));
});

test('resetting an unknown user reports failure instead of silently succeeding', () => {
  assert.equal(setUserPassword('no-such-user-id', 'password12345'), false);
});

test('a reset does not touch the role', () => {
  const u = createUser(fresh(), 'password12345', 'admin');
  setUserPassword(u.id, 'anotherpass1');
  assert.equal(getUserById(u.id).role, 'admin', 'a password reset must not demote anyone');
});

/* ---------------- env seeding ---------------- */

test('the env account is created as an admin', () => {
  const name = fresh();
  const prevUser = process.env.USER_USERNAME;
  const prevPass = process.env.USER_PASSWORD;
  process.env.USER_USERNAME = name;
  process.env.USER_PASSWORD = 'envpassword123';
  try {
    seedAdminFromEnv();
    const u = readUsers().find((x) => x.username === name);
    assert.ok(u, 'the env account was created');
    assert.equal(u.role, 'admin', 'the env account is the first admin');
  } finally {
    if (prevUser === undefined) delete process.env.USER_USERNAME; else process.env.USER_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.USER_PASSWORD; else process.env.USER_PASSWORD = prevPass;
  }
});

test('seeding is idempotent: a second boot does not create a second account', () => {
  const name = fresh();
  const prevUser = process.env.USER_USERNAME;
  const prevPass = process.env.USER_PASSWORD;
  process.env.USER_USERNAME = name;
  process.env.USER_PASSWORD = 'envpassword123';
  try {
    seedAdminFromEnv();
    seedAdminFromEnv();
    const matches = readUsers().filter((x) => x.username === name);
    assert.equal(matches.length, 1, 'exactly one account after two boots');
    assert.equal(matches[0].role, 'admin');
  } finally {
    if (prevUser === undefined) delete process.env.USER_USERNAME; else process.env.USER_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.USER_PASSWORD; else process.env.USER_PASSWORD = prevPass;
  }
});

test('seeding promotes only the account the env names', () => {
  const envName = fresh();
  const bystanderName = fresh();
  const bystander = createUser(bystanderName, 'password12345'); // a pre-existing regular user
  const prevUser = process.env.USER_USERNAME;
  const prevPass = process.env.USER_PASSWORD;
  process.env.USER_USERNAME = envName;
  process.env.USER_PASSWORD = 'envpassword123';
  try {
    seedAdminFromEnv();
    assert.equal(getUserById(bystander.id).role, 'user', 'a boot must not promote anyone else');
    assert.equal(readUsers().find((x) => x.username === envName).role, 'admin');
  } finally {
    if (prevUser === undefined) delete process.env.USER_USERNAME; else process.env.USER_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.USER_PASSWORD; else process.env.USER_PASSWORD = prevPass;
  }
});

test('seeding with no env configured changes nothing', () => {
  const prevUser = process.env.USER_USERNAME;
  const prevPass = process.env.USER_PASSWORD;
  const prevAdminUser = process.env.ADMIN_USER;
  const prevAdminPass = process.env.ADMIN_PASSWORD;
  delete process.env.USER_USERNAME; delete process.env.USER_PASSWORD;
  delete process.env.ADMIN_USER; delete process.env.ADMIN_PASSWORD;
  try {
    const before = readUsers().length;
    seedAdminFromEnv();
    assert.equal(readUsers().length, before, 'no account appears without env');
  } finally {
    if (prevUser !== undefined) process.env.USER_USERNAME = prevUser;
    if (prevPass !== undefined) process.env.USER_PASSWORD = prevPass;
    if (prevAdminUser !== undefined) process.env.ADMIN_USER = prevAdminUser;
    if (prevAdminPass !== undefined) process.env.ADMIN_PASSWORD = prevAdminPass;
  }
});
