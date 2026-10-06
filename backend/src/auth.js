// Username+password auth — crypto-native, no deps. Users in data/users.json,
// sessions persisted to data/sessions.json (survive backend restarts).
// Hashing: scrypt (new) with on-login migration from legacy sha256.
import { createHash, randomBytes, randomUUID, timingSafeEqual, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './persistence.js';

const USERS_FILE = join(DATA_DIR, 'users.json');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

/** scrypt hash — format: `scrypt$<salt>$<hex>` (scheme-tagged for migration). */
function hashPasswordScrypt(password, salt) {
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Legacy sha256 hash — kept only to verify + migrate old records. */
function hashPasswordSha256(password, salt) {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function verifyPassword(password, user) {
  if (String(user.hash).startsWith('scrypt$')) {
    const [, salt] = String(user.hash).split('$');
    const got = hashPasswordScrypt(password, salt);
    const a = Buffer.from(got);
    const b = Buffer.from(user.hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // Legacy sha256 record
  const got = hashPasswordSha256(password, user.salt);
  if (got.length !== user.hash.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(user.hash, 'hex'));
}

function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

/**
 * Load the account store, refusing to treat a damaged file as "no users".
 *
 * `loadJson`'s catch-to-fallback is right for caches and wrong here: a
 * truncated users.json (crash mid-write, full disk, bad hand-edit) would read
 * as an empty list, and the next write — most likely the admin add-user route —
 * would overwrite every account with a single record and still report success.
 * Every per-user state file is keyed by the lost ids, so the loss is silent and
 * total. A missing file is different: that is a genuine fresh install.
 *
 * Throws rather than returning [], so callers fail loudly and the file is left
 * untouched for recovery.
 */
function loadUsers() {
  if (!existsSync(USERS_FILE)) return [];
  let parsed;
  try { parsed = JSON.parse(readFileSync(USERS_FILE, 'utf-8')); }
  catch (e) {
    throw new Error(`users.json tidak bisa dibaca (JSON rusak) — perbaiki atau pindahkan file itu dulu: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('users.json tidak bisa dibaca (bukan array) — perbaiki atau pindahkan file itu dulu');
  }
  return parsed;
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function saveUsers(users) {
  atomicWrite(USERS_FILE, users);
}

/**
 * The effective role of a user record.
 *
 * Fail closed: only an own 'admin' property grants admin. A missing field
 * (every record written before roles existed), a typo, or a value inherited
 * from Object.prototype all read as 'user'. The own-property check is load
 * bearing — plain `user.role` walks the prototype chain, so a record whose
 * prototype had been polluted would otherwise grant admin.
 */
export function roleOf(user) {
  if (!user || typeof user !== 'object') return 'user';
  return Object.hasOwn(user, 'role') && user.role === 'admin' ? 'admin' : 'user';
}

/** Create a user (idempotent: existing username → false). */
export function createUser(username, password, role = 'user') {
  // Guard the shape here too: this is also the env-seed path, and a non-string
  // username would be written to disk and then never match a login lookup.
  if (typeof username !== 'string' || !username) return false;
  if (typeof password !== 'string' || !password) return false;
  const users = loadUsers();
  if (users.some((u) => u.username === username)) return false;
  const salt = randomBytes(16).toString('hex');
  const user = {
    id: randomUUID(),
    username,
    // Normalised on write too, so a caller cannot store a role the reader
    // would not honour (or vice versa).
    role: roleOf({ role }),
    salt,
    hash: hashPasswordScrypt(password, salt),
    createdAt: Date.now(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}

/**
 * Find the account that owns `address`, or null.
 *
 * Compared lowercased: one EVM address has many valid checksum casings, so a
 * case-sensitive match would silently fail to resolve a user who is already
 * registered under a different casing.
 */
export function findUserByAddress(address) {
  const canonical = String(address ?? '').toLowerCase();
  if (!canonical) return null;
  return loadUsers().find((u) => typeof u.address === 'string' && u.address === canonical) ?? null;
}

export function verifyUser(username, password) {
  const user = loadUsers().find((u) => u.username === username);
  // Always hash (decoy) so response timing does not reveal whether a username
  // exists; scrypt cost dominates either way.
  if (!user) {
    hashPasswordScrypt(password, 'decoy0000000000000000000000000000');
    return null;
  }
  const ok = verifyPassword(password, user);
  if (!ok) return null;
  // On-login migration: legacy sha256 record → rehash with scrypt.
  if (!String(user.hash).startsWith('scrypt$')) {
    const users = loadUsers();
    const rec = users.find((u) => u.id === user.id);
    if (rec) {
      const salt = randomBytes(16).toString('hex');
      rec.salt = salt;
      rec.hash = hashPasswordScrypt(password, salt);
      saveUsers(users);
    }
  }
  return user;
}

export function getUserById(id) {
  return loadUsers().find((u) => u.id === id) ?? null;
}

/** True only for an exact 'admin' role. Absent/unknown roles read as 'user'. */
export function isAdmin(userId) {
  return roleOf(getUserById(userId)) === 'admin';
}

/**
 * Replace a user's password (admin action).
 *
 * Returns false when the id matches nothing, so the route can 404 rather than
 * reporting success for a no-op. Also (re)writes salt+hash for an account that
 * had none — a legacy wallet-only record has no password material at all, and
 * this is the only way to give it one now that wallet login is gone.
 */
export function setUserPassword(userId, newPassword) {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return false;
  const salt = randomBytes(16).toString('hex');
  users[idx] = { ...users[idx], salt, hash: hashPasswordScrypt(newPassword, salt) };
  saveUsers(users);
  return true;
}

/** Change own password after verifying the current one. */
export function changePassword(userId, currentPassword, newPassword) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) throw new Error('User tidak ditemukan');
  if (!verifyPassword(currentPassword, user)) throw new Error('Password lama salah');
  const salt = randomBytes(16).toString('hex');
  user.salt = salt;
  user.hash = hashPasswordScrypt(newPassword, salt);
  saveUsers(users);
  return true;
}

/** Public user list for the leaderboard (no salt/hash, and no role: whether
 *  someone is an admin is not the leaderboard's business). */
export function listUsers() {
  // `address` is included so a legacy wallet-only account (which has no
  // username) can still be identified in the leaderboard. Still no credential
  // material.
  return loadUsers().map(({ id, username, address, createdAt }) => ({ id, username, address, createdAt }));
}

/**
 * Admin view of every account, newest first.
 *
 * `hasPassword` is a boolean, never the hash or salt — the admin needs to know
 * which accounts can actually log in, not what their credentials are.
 */
export function listAccounts() {
  return loadUsers()
    .map((u) => ({
      id: u.id,
      username: u.username ?? null,
      address: u.address ?? null,
      role: roleOf(u),
      hasPassword: typeof u.hash === 'string' && u.hash.length > 0,
      createdAt: u.createdAt,
    }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// --- Sessions (persisted to data/sessions.json) ---
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const sessions = new Map(loadJson(SESSIONS_FILE, []).map((s) => [s.token, { userId: s.userId, createdAt: s.createdAt }]));

function saveSessions() {
  atomicWrite(SESSIONS_FILE, [...sessions.entries()].map(([token, s]) => ({ token, userId: s.userId, createdAt: s.createdAt })));
}

/** Drop expired sessions so the map cannot grow unbounded. */
function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); changed = true; }
  }
  if (changed) saveSessions();
}
pruneSessions();

export function createSession(userId) {
  pruneSessions();
  // 256-bit base64url token — far beyond guessable, and safe in headers/URLs.
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId, createdAt: Date.now() });
  saveSessions();
  return token;
}

export function getUser(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); saveSessions(); return null; }
  return s.userId;
}

export function destroySession(token) {
  if (sessions.delete(token)) saveSessions();
}

/** Revoke every session of a user except the one to keep (password change). */
export function destroyOtherSessions(userId, keepToken) {
  let changed = false;
  for (const [token, s] of sessions) {
    if (s.userId === userId && token !== keepToken) { sessions.delete(token); changed = true; }
  }
  if (changed) saveSessions();
}

/**
 * Seed the operator account from env, and make sure it is an admin.
 *
 * This is the only way the FIRST admin comes into existence: there is no
 * registration, and no endpoint can promote anyone. Two rules keep it safe:
 *
 *  - The env account is always an admin. Whoever holds the .env on the server
 *    already controls the process, so gating this adds no security, and NOT
 *    doing it is how an install ends up with no admin and no way to get one.
 *  - Promotion is limited to that env-named account. Nothing else is ever
 *    promoted, so a second admin cannot appear because a boot happened.
 *
 * Idempotent: a second boot finds the account already correct and does nothing.
 */
export function seedAdminFromEnv() {
  const username = process.env.USER_USERNAME || process.env.ADMIN_USER;
  const password = process.env.USER_PASSWORD || process.env.ADMIN_PASSWORD;
  // A corrupt store must not be fatal. Failing closed is about refusing the
  // WRITE; crashing the process here would take down market data and every
  // other user for one damaged file. Log loudly, leave the file alone, and let
  // every read/write that actually needs the store throw on its own.
  let users;
  try {
    users = loadUsers();
  } catch (e) {
    console.error(`\n[!] users.json rusak — seed admin dilewati. Perbaiki atau pindahkan file itu, lalu restart.\n    ${e.message}\n`);
    return;
  }
  if (!username || !password) {
    if (users.length === 0) console.log('\n[!] Belum ada user. Set USER_USERNAME dan USER_PASSWORD lalu restart.\n');
    return;
  }

  const existing = users.find((u) => u.username === username);
  if (!existing) {
    const user = createUser(username, password, 'admin');
    if (user) console.log(`\n[i] Admin dibuat dari env: ${user.username}\n`);
    return;
  }
  if (roleOf(existing) !== 'admin') {
    // Promote only the record this env names. Deliberately loud: this changes
    // who can create accounts, so it must be visible in the boot log.
    const rec = users.find((u) => u.id === existing.id);
    rec.role = 'admin';
    saveUsers(users);
    console.log(`\n[i] Akun env dinaikkan menjadi admin: ${rec.username}\n`);
  }
}