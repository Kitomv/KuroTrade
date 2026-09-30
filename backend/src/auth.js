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

function loadUsers() {
  // No implicit admin promotion: registration is disabled and roles must not
  // change merely because an admin record is absent.
  return loadJson(USERS_FILE, []);
}

function saveUsers(users) {
  atomicWrite(USERS_FILE, users);
}

/** Create a user (idempotent: existing username → false). */
export function createUser(username, password, role = 'user') {
  const users = loadUsers();
  if (users.some((u) => u.username === username)) return false;
  const salt = randomBytes(16).toString('hex');
  const user = {
    id: randomUUID(),
    username,
    salt,
    hash: hashPasswordScrypt(password, salt),
    role,
    createdAt: Date.now(),
  };
  users.push(user);
  saveUsers(users);
  return user;
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

/** Admin sets a new password for any user (no current-password check). */
export function adminSetPassword(userId, newPassword) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) throw new Error('User tidak ditemukan');
  const salt = randomBytes(16).toString('hex');
  user.salt = salt;
  user.hash = hashPasswordScrypt(newPassword, salt);
  saveUsers(users);
  destroyUserSessions(userId);
  return true;
}

/** Public user list for admin/leaderboard (no salt/hash). */
export function listUsers() {
  return loadUsers().map(({ id, username, role, createdAt }) => ({ id, username, role, createdAt }));
}

/** Delete a user: record + sessions + their state file. */
export function deleteUser(userId) {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) throw new Error('User tidak ditemukan');
  users.splice(idx, 1);
  saveUsers(users);
  destroyUserSessions(userId);
  try { unlinkSync(join(DATA_DIR, `${userId}.json`)); } catch {}
  return true;
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

function destroyUserSessions(userId) {
  let changed = false;
  for (const [token, s] of sessions) {
    if (s.userId === userId) { sessions.delete(token); changed = true; }
  }
  if (changed) saveSessions();
}

/** Add one regular user from env when their username is not present.
 *  Registration is disabled, so this is the manual account-creation path. */
export function seedAdminFromEnv() {
  const username = process.env.USER_USERNAME || process.env.ADMIN_USER;
  const password = process.env.USER_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    if (loadUsers().length === 0) console.log('\n[!] Belum ada user. Set USER_USERNAME dan USER_PASSWORD lalu restart.\n');
    return;
  }
  const user = createUser(username, password, 'user');
  if (user) console.log(`\n[i] Akun manual dibuat dari env: ${user.username}\n`);
}