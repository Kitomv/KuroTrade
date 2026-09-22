// Per-user in-memory stores: watchlist + price history.
// Persistence via registered provider (persistence.js serializes all providers).

import { touch, registerStateProvider } from './persistence.js';

const watchlists = new Map();
const histories = new Map();
const MAX_HISTORY = 500;

function watchFor(userId) {
  if (!watchlists.has(userId)) watchlists.set(userId, new Map());
  return watchlists.get(userId);
}
function historyFor(userId) {
  if (!histories.has(userId)) histories.set(userId, new Map());
  return histories.get(userId);
}

// Load a user's persisted watchlist/history into memory (call once at startup).
export function initUserStores(userId, persisted) {
  if (!persisted) return;
  if (Array.isArray(persisted.watchlist)) {
    for (const [k, v] of persisted.watchlist) watchFor(userId).set(k, v);
  }
  if (Array.isArray(persisted.history)) {
    for (const [k, v] of persisted.history) historyFor(userId).set(k, v);
  }
}

export function addWatchlist(userId, entry) {
  const key = `${entry.chainId}:${entry.tokenAddress}`;
  watchFor(userId).set(key, { ...entry, addedAt: Date.now() });
  touch(userId);
  return key;
}

export function removeWatchlist(userId, key) {
  watchFor(userId).delete(key);
  historyFor(userId).delete(key);
  touch(userId);
}

export function getWatchlist(userId) {
  return [...watchFor(userId).values()];
}

export function pushHistory(userId, chainId, tokenAddress, priceUsd) {
  const arr = historyFor(userId);
  const key = `${chainId}:${tokenAddress}`;
  if (!arr.has(key)) arr.set(key, []);
  const list = arr.get(key);
  list.push({ priceUsd, ts: Date.now() });
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  touch(userId);
  return list;
}

export function getHistory(userId, chainId, tokenAddress) {
  return historyFor(userId).get(`${chainId}:${tokenAddress}`) ?? [];
}

// Store slice provider — reads live maps at flush time (never creates state).
registerStateProvider((userId) => {
  if (!watchlists.has(userId) && !histories.has(userId)) return null;
  return {
    watchlist: [...watchFor(userId)],
    history: [...historyFor(userId)],
  };
});