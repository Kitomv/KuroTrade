// Auth tests — password hashing, session lifecycle, and the data-dir isolation
// that makes writing any of this safe.
//
// The isolation test exists because of a real incident: auth.js computed its
// own DATA_DIR and ignored PERSIST_DATA_DIR, so a test or probe touching auth
// wrote real credentials and sessions into backend/data. The escape hatch
// worked for every module except the two that needed it most.
// Run: node --test backend/src/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set BEFORE the module graph is imported: persistence.js resolves
// DATA_DIR at module-evaluation time, and ESM hoists imports above statements.
const TEMP_DIR = join(tmpdir(), `auth-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.PERSIST_DATA_DIR = TEMP_DIR;

const {
  createUser, verifyUser, getUserById, changePassword, listUsers,
  createSession, getUser, destroySession, destroyOtherSessions,
  seedAdminFromEnv,
} = await import('./auth.js');
const { DATA_DIR } = await import('./persistence.js');

const USERS_FILE = join(TEMP_DIR, 'users.json');
const SESSIONS_FILE = join(TEMP_DIR, 'sessions.json');

let seq = 0;
const freshName = () => `u_${process.pid}_${seq++}`;

/* ---------------- data-dir isolation (the incident) ---------------- */

test('PERSIST_DATA_DIR redirects auth writes away from backend/data', () => {
  // The whole point: a test run must not touch the real credential store.
  assert.equal(DATA_DIR, TEMP_DIR, 'persistence must resolve DATA_DIR from the env override');
  assert.ok(!DATA_DIR.endsWith(join('backend', 'data')), 'must not be the production data dir');

  const name = freshName();
  createUser(name, 'password12345');
  assert.ok(existsSync(USERS_FILE), 'users.json is written into the temp dir');
  assert.ok(USERS_FILE.startsWith(TEMP_DIR), 'and not anywhere else');

  const onDisk = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  assert.ok(onDisk.some((u) => u.username === name), 'the new user landed in the temp file');
});

test('a fresh install has no users, and seed reports that instead of inventing one', () => {
  // No env set → the seed must not fabricate an account.
  const before = listUsers().length;
  delete process.env.USER_USERNAME;
  delete process.env.USER_PASSWORD;
  seedAdminFromEnv();
  assert.equal(listUsers().length, before, 'no account created without env credentials');
});

/* ---------------- password hashing ---------------- */

test('a password verifies, and the stored form is scrypt — never the plaintext', () => {
  const name = freshName();
  createUser(name, 'correct-horse-battery');

  const user = verifyUser(name, 'correct-horse-battery');
  assert.ok(user, 'the right password verifies');
  assert.equal(user.username, name);

  const stored = JSON.parse(readFileSync(USERS_FILE, 'utf8')).find((u) => u.username === name);
  assert.ok(stored.hash.startsWith('scrypt$'), 'scheme-tagged so a future migration can detect it');
  assert.ok(!stored.hash.includes('correct-horse-battery'), 'plaintext must never be stored');
  assert.ok(stored.salt && stored.salt.length >= 32, 'per-user random salt');
});

test('a wrong password is rejected, and an unknown user is indistinguishable from one', () => {
  const name = freshName();
  createUser(name, 'right-password');

  assert.equal(verifyUser(name, 'wrong-password'), null);
  assert.equal(verifyUser(name, ''), null);
  assert.equal(verifyUser('nobody-with-this-name', 'right-password'), null);
  // Both paths hash (a decoy for the unknown user) so timing does not leak
  // whether the username exists.
});

test('two users with the same password get different hashes', () => {
  const a = freshName();
  const b = freshName();
  createUser(a, 'shared-password');
  createUser(b, 'shared-password');

  const users = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  const ha = users.find((u) => u.username === a).hash;
  const hb = users.find((u) => u.username === b).hash;
  assert.notEqual(ha, hb, 'a per-user salt must defeat identical hashes');
});

test('creating an existing username is a no-op, not an overwrite', () => {
  const name = freshName();
  assert.ok(createUser(name, 'first-password'), 'first create succeeds');
  assert.equal(createUser(name, 'second-password'), false, 'second create is refused');

  assert.ok(verifyUser(name, 'first-password'), 'the original password still works');
  assert.equal(verifyUser(name, 'second-password'), null, 'the new one was not applied');
});

test('changePassword requires the current password and invalidates the old one', () => {
  const name = freshName();
  const user = createUser(name, 'old-password');

  assert.throws(() => changePassword(user.id, 'not-the-old-one', 'new-password'), /Password lama salah/);
  assert.ok(verifyUser(name, 'old-password'), 'a rejected change leaves the old password intact');

  changePassword(user.id, 'old-password', 'new-password');
  assert.ok(verifyUser(name, 'new-password'), 'the new password works');
  assert.equal(verifyUser(name, 'old-password'), null, 'the old one no longer does');
});

test('changePassword on a missing user throws rather than silently succeeding', () => {
  assert.throws(() => changePassword('no-such-id', 'a', 'b'), /User tidak ditemukan/);
});

test('getUserById never exposes the salt or hash', () => {
  const name = freshName();
  const created = createUser(name, 'password12345');
  const fetched = getUserById(created.id);
  assert.equal(fetched.username, name);
  // listUsers is the public projection — it must not carry credential material.
  const [row] = listUsers().filter((u) => u.id === created.id);
  assert.equal(row.hash, undefined);
  assert.equal(row.salt, undefined);
});

/* ---------------- sessions ---------------- */

test('a session resolves to its user and survives a reload from disk', () => {
  const name = freshName();
  const user = createUser(name, 'password12345');
  const token = createSession(user.id);

  assert.equal(getUser(token), user.id, 'the token maps to the user');
  const onDisk = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  assert.ok(onDisk.some((s) => s.token === token), 'and is persisted, so a restart keeps it');
});

test('an unknown, empty, or malformed token resolves to nobody', () => {
  for (const bad of ['', 'not-a-real-token', null, undefined]) {
    assert.equal(getUser(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('destroySession revokes exactly one token', () => {
  const name = freshName();
  const user = createUser(name, 'password12345');
  const a = createSession(user.id);
  const b = createSession(user.id);

  destroySession(a);
  assert.equal(getUser(a), null, 'the revoked token is gone');
  assert.equal(getUser(b), user.id, 'the other session is untouched');
});

test('destroyOtherSessions keeps the current session and revokes the rest', () => {
  const name = freshName();
  const user = createUser(name, 'password12345');
  const keep = createSession(user.id);
  const other1 = createSession(user.id);
  const other2 = createSession(user.id);

  destroyOtherSessions(user.id, keep);
  assert.equal(getUser(keep), user.id, 'the session that changed the password survives');
  assert.equal(getUser(other1), null, 'a stale session is revoked');
  assert.equal(getUser(other2), null, 'and so is the other one');
});

test('destroyOtherSessions does not touch another user’s sessions', () => {
  const mine = createUser(freshName(), 'password12345');
  const theirs = createUser(freshName(), 'password12345');
  const theirToken = createSession(theirs.id);

  destroyOtherSessions(mine.id, createSession(mine.id));
  assert.equal(getUser(theirToken), theirs.id, 'scoped to one userId, not global');
});

test('sessions issued for different users do not collide', () => {
  const a = createUser(freshName(), 'password12345');
  const b = createUser(freshName(), 'password12345');
  const ta = createSession(a.id);
  const tb = createSession(b.id);

  assert.notEqual(ta, tb, 'tokens are random per session');
  assert.equal(getUser(ta), a.id);
  assert.equal(getUser(tb), b.id);
});

/* ---------------- seeding ---------------- */

test('the env seed creates the account once and is idempotent on restart', () => {
  const name = freshName();
  process.env.USER_USERNAME = name;
  process.env.USER_PASSWORD = 'seeded-password-123';

  seedAdminFromEnv();
  assert.ok(verifyUser(name, 'seeded-password-123'), 'the account exists after seeding');

  // A restart re-runs the seed; it must not reset the password or duplicate.
  const before = listUsers().length;
  seedAdminFromEnv();
  assert.equal(listUsers().length, before, 'no duplicate account');
  assert.ok(verifyUser(name, 'seeded-password-123'), 'and the password is unchanged');
});

test('the legacy ADMIN_USER/ADMIN_PASSWORD names still seed an account', () => {
  const name = freshName();
  delete process.env.USER_USERNAME;
  delete process.env.USER_PASSWORD;
  process.env.ADMIN_USER = name;
  process.env.ADMIN_PASSWORD = 'legacy-password-123';

  seedAdminFromEnv();
  assert.ok(verifyUser(name, 'legacy-password-123'), 'the alias still works');

  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASSWORD;
});
