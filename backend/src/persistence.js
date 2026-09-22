// Per-user JSON persistence — debounced atomic writes, provider-based snapshots.
// Modules register providers; a flush serializes each provider's live state so
// disjoint writers (wallet / store / autopilot) never clobber each other.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

const SAVE_DEBOUNCE_MS = 500;
const pending = new Map(); // userId -> timer
const providers = [];      // (userId) => partial state | null

/**
 * Current per-user state schema. Bump when a persisted field changes meaning or
 * shape, and handle the old value in `migrateState` below.
 *   v1 → initial release (wallet/positions/orders, watchlist, autopilot, llm).
 *   v2 → wallet number hardening (finite/clamped balance, sanitized positions).
 */
export const STATE_SCHEMA_VERSION = 2;

/** Upgrade a loaded state object in place; unknown/older shapes are tolerated. */
function migrateState(state) {
  if (!state || typeof state !== 'object') return state;
  const version = Number(state.schemaVersion) || 1;
  if (version < 2) state.schemaVersion = 2;
  return state;
}

/** Register a state provider; called at flush time, must not create state. */
export function registerStateProvider(fn) {
  providers.push(fn);
}

function buildState(userId) {
  let state = {};
  for (const fn of providers) {
    try {
      const part = fn(userId);
      if (part) state = { ...state, ...part };
    } catch {}
  }
  state.schemaVersion = STATE_SCHEMA_VERSION;
  return state;
}

function pathFor(userId) {
  return join(DATA_DIR, `${userId}.json`);
}

export function loadUserState(userId) {
  const p = pathFor(userId);
  if (!existsSync(p)) return null;
  try {
    const state = JSON.parse(readFileSync(p, 'utf-8'));
    return migrateState(state);
  } catch { return null; }
}

/** Queue a debounced save for a user — safe to call on every mutation. */
export function touch(userId) {
  const existing = pending.get(userId);
  if (existing) clearTimeout(existing);
  pending.set(userId, setTimeout(() => flushUser(userId), SAVE_DEBOUNCE_MS));
}

function flushUser(userId) {
  pending.delete(userId);
  const target = pathFor(userId);
  // Unique temp name per write: a second backend process (or a stale one that
  // did not exit) shares this path, and a fixed `.tmp` name lets one process
  // rename the other's temp file away → ENOENT on the loser's rename.
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(buildState(userId)), 'utf-8');
    renameSync(tmp, target); // atomic on same volume
  } catch (e) {
    console.error(`[persist] save failed for ${userId}: ${e.message}`);
    try { unlinkSync(tmp); } catch {}
  }
}

/** Remove orphaned temp files left by a crashed process (best effort). */
export function cleanupTempFiles() {
  try {
    for (const f of readdirSync(DATA_DIR)) {
      if (f.endsWith('.tmp')) {
        try { unlinkSync(join(DATA_DIR, f)); } catch {}
      }
    }
  } catch {}
}

/** Flush on shutdown so nothing is lost on SIGINT. */
export function flushAll() {
  for (const [userId, timer] of [...pending]) {
    clearTimeout(timer);
    flushUser(userId);
  }
}