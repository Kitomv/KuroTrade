// Per-user in-memory virtual wallet for paper trading. Default start: $100 USDC.
// Wallet.js owns the single per-user persistence file (wallet + positions + orders
// + stores snapshot). Autopilot config is saved via aiAgent's snapshot merged here.

import { loadUserState, touch, registerStateProvider } from './persistence.js';
import { initUserStores } from './store.js';

const INITIAL_BALANCE = 100.00;
const MAX_VIRTUAL_USD = 1_000_000;
const MAX_TOKEN_AMOUNT = 1e30;
const MAX_TOKEN_PRICE = 1e12;

function finitePositive(value, label, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${label} tidak valid`);
  return n;
}

// userId -> { balance, positions: Map, orders: [], nextOrderId }
const wallets = new Map();

function walletFor(userId) {
  if (!wallets.has(userId)) {
    wallets.set(userId, {
      balance: INITIAL_BALANCE,
      initialBalance: INITIAL_BALANCE, // user-configurable starting amount
      positions: new Map(), // tokenAddress -> position
      orders: [],
      nextOrderId: 1,
      realizedPnl: 0, // cumulative, lives here so closing a position cannot erase it
    });
  }
  return wallets.get(userId);
}

function uid(w) {
  return `ord_${Date.now()}_${w.nextOrderId++}`;
}

/**
 * Book a realized gain/loss against the WALLET, not the position.
 *
 * This used to accumulate on the position object, and getWallet summed
 * position.realizedPnl across the open positions. A fully-closed position is
 * deleted from the map, so its profit was deleted with it — the "Realized PnL"
 * KPI read $0 after every complete round trip, and only a partially-sold
 * position ever showed a non-zero total. Realized PnL must outlive the
 * position that produced it.
 */
function updateRealizedPnl(w, amount) {
  const next = (Number(w.realizedPnl) || 0) + Number(amount);
  w.realizedPnl = Number.isFinite(next) ? next : (Number(w.realizedPnl) || 0);
}

/** Load a user's persisted wallet+orders into memory (call once at startup). */
export function initWallet(userId) {
  const saved = loadUserState(userId);
  if (!saved) return;
  const w = walletFor(userId);
  if (Number.isFinite(saved.balance)) w.balance = Math.min(MAX_VIRTUAL_USD, Math.max(0, Number(saved.balance)));
  if (Number.isFinite(saved.initialBalance) && saved.initialBalance > 0) w.initialBalance = Math.min(MAX_VIRTUAL_USD, Number(saved.initialBalance));
  w.nextOrderId = Number.isSafeInteger(saved.nextOrderId) && saved.nextOrderId > 0 ? saved.nextOrderId : 1;
  // Fall back to the sum of the per-position figures for a state file written
  // before realized PnL was tracked at the wallet level, so an upgrade does not
  // silently zero a total the user has already earned.
  const storedPnl = Number(saved.realizedPnl);
  if (Number.isFinite(storedPnl)) w.realizedPnl = clampUsd(storedPnl);
  else {
    const legacy = (Array.isArray(saved.positions) ? saved.positions : [])
      .reduce((s, p) => s + (Number(p?.realizedPnl) || 0), 0);
    if (Number.isFinite(legacy) && legacy !== 0) w.realizedPnl = clampUsd(legacy);
  }
  w.positions = new Map(
    (Array.isArray(saved.positions) ? saved.positions : [])
      .map((p) => sanitizePosition(p))
      .filter(Boolean)
      .map((p) => [p.tokenAddress, p]),
  );
  w.orders = (Array.isArray(saved.orders) ? saved.orders : [])
    .filter((o) => o && typeof o.id === 'string' && Number.isFinite(Number(o.usdAmount)) && Number(o.usdAmount) >= 0 && Number(o.usdAmount) <= MAX_VIRTUAL_USD)
    .slice(0, MAX_ORDERS);
  initUserStores(userId, saved);
}

/** Debounced save of this user's wallet slice (other slices come from providers). */
export function saveUserState(userId) {
  touch(userId);
}

// Wallet slice provider — registered once; reads live state at flush time.
// Positions must serialize WITH their tokenAddress (it lives in the Map key,
// not the position object) or initWallet cannot rebuild the Map on load.
registerStateProvider((userId) => {
  const w = wallets.get(userId);
  if (!w) return null;
  return {
    balance: w.balance,
    initialBalance: w.initialBalance,
    nextOrderId: w.nextOrderId,
    realizedPnl: Number(w.realizedPnl) || 0,
    positions: [...w.positions.entries()].map(([tokenAddress, p]) => ({ ...p, tokenAddress })),
    orders: w.orders,
  };
});

/** Defensive read-side clamp: a corrupted state file (or a bad upstream price)
 *  must never surface absurd numbers in the UI. */
function clampUsd(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_VIRTUAL_USD, Math.max(-MAX_VIRTUAL_USD, v));
}

/**
 * Validate one position (persisted or live). Returns null when a field is
 * non-finite/absurd, so corrupted rows are dropped instead of poisoning every
 * derived number (the 1.38e+47-token incident).
 */
function sanitizePosition(p) {
  if (!p || typeof p.tokenAddress !== 'string' || !p.tokenAddress) return null;
  const amount = Number(p.amount);
  const avgBuyPrice = Number(p.avgBuyPrice);
  const totalCost = Number(p.totalCost);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TOKEN_AMOUNT) return null;
  if (!Number.isFinite(avgBuyPrice) || avgBuyPrice <= 0 || avgBuyPrice > MAX_TOKEN_PRICE) return null;
  if (!Number.isFinite(totalCost) || totalCost < 0 || totalCost > MAX_VIRTUAL_USD) return null;
  const currentPrice = Number(p.currentPrice);
  const highestPrice = Number(p.highestPrice);
  return {
    ...p,
    amount,
    avgBuyPrice,
    totalCost,
    currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 && currentPrice <= MAX_TOKEN_PRICE ? currentPrice : avgBuyPrice,
    highestPrice: Number.isFinite(highestPrice) && highestPrice > 0 && highestPrice <= MAX_TOKEN_PRICE ? Math.max(highestPrice, avgBuyPrice) : avgBuyPrice,
  };
}

const MAX_ORDERS = 500;

export function getWallet(userId) {
  const w = walletFor(userId);
  // Purge corrupt rows once so they stop poisoning every derived number.
  let purged = false;
  for (const [key, p] of w.positions) {
    const clean = sanitizePosition({ ...p, tokenAddress: key });
    if (!clean) { w.positions.delete(key); purged = true; }
    else if (clean.amount !== p.amount || clean.currentPrice !== p.currentPrice) { w.positions.set(key, clean); purged = true; }
  }
  if (purged) saveUserState(userId);

  let totalPositionValue = 0;
  let unrealizedPnl = 0;
  for (const [, p] of w.positions) {
    const cur = Number(p.currentPrice) || Number(p.avgBuyPrice) || 0;
    const value = (Number(p.amount) || 0) * cur;
    if (Number.isFinite(value)) totalPositionValue += Math.min(MAX_VIRTUAL_USD, Math.max(0, value));
    const unreal = value - (Number(p.totalCost) || 0);
    if (Number.isFinite(unreal)) unrealizedPnl += unreal;
  }
  const reservedUsd = w.orders
    .filter((o) => o.type === 'limit' && o.side === 'buy' && o.status === 'open')
    .reduce((s, o) => s + (Number(o.usdAmount) || 0), 0);
  const curBal = clampUsd(Math.round(clampUsd(w.balance) * 100) / 100);
  const totPos = clampUsd(Math.round(totalPositionValue * 100) / 100);
  const totVal = clampUsd(Math.round((curBal + totPos) * 100) / 100);
  const totPnl = clampUsd(Math.round((Number(w.realizedPnl) || 0) * 100) / 100);
  const totUnreal = clampUsd(Math.round(unrealizedPnl * 100) / 100);

  return {
    balance: curBal,
    available: Math.max(0, curBal - Math.round(clampUsd(reservedUsd) * 100) / 100),
    initialBalance: clampUsd(w.initialBalance, INITIAL_BALANCE),
    totalValue: totVal,
    totalPositionValue: totPos,
    unrealizedPnl: totUnreal,
    realizedPnl: totPnl,
    reservedUsd: Math.round(clampUsd(reservedUsd) * 100) / 100,
  };
}

export function updatePositionPrices(userId, priceMap) {
  const w = walletFor(userId);
  // The token address lives in the Map KEY, not on the position object — it is
  // only attached at serialisation time (the provider below). Reading
  // p.tokenAddress here always yielded undefined, so every lookup missed and
  // this function silently did nothing: positions kept their entry price
  // forever, and the guardian's SL/TP checks ran against a stale cost basis.
  for (const [tokenAddress, p] of w.positions) {
    const fresh = priceMap.get(tokenAddress);
    // Reject non-finite / absurd ticks (Infinity passes a naive `> 0` check).
    if (fresh == null) continue;
    const num = Number(fresh);
    if (!Number.isFinite(num) || num <= 0 || num > MAX_TOKEN_PRICE) continue;
    p.currentPrice = num;
    const prevHigh = Number(p.highestPrice);
    p.highestPrice = Math.min(MAX_TOKEN_PRICE, Math.max(Number.isFinite(prevHigh) && prevHigh > 0 ? prevHigh : num, num));
  }
  saveUserState(userId);
}

export function updatePositionMetadata(userId, tokenAddress, meta = {}) {
  const w = walletFor(userId);
  const p = w.positions.get(tokenAddress);
  if (p) {
    Object.assign(p, meta);
    saveUserState(userId);
  }
}

/**
 * Mirror a FILLED real sell: reduce (or drop) the virtual position by the
 * amount actually sold. Without this the guardian keeps seeing the position,
 * re-emits the same exit intent on every tick, and — with auto-execute on —
 * tries to sell real tokens that are already gone. No virtual cash is
 * credited: this is book-keeping, not a paper trade.
 */
export function reducePositionAmount(userId, tokenAddress, tokens) {
  const w = walletFor(userId);
  const p = w.positions.get(tokenAddress);
  if (!p) return null;
  const cur = Number(p.amount) || 0;
  const qty = Math.min(Number(tokens) || 0, cur);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const avg = Number(p.avgBuyPrice) || 0;
  const remaining = cur - qty;
  if (remaining < 1e-8) {
    w.positions.delete(tokenAddress);
  } else {
    w.positions.set(tokenAddress, {
      ...p,
      amount: remaining,
      totalCost: Math.max(0, (Number(p.totalCost) || 0) - qty * avg),
    });
  }
  saveUserState(userId);
  return { tokenAddress, remaining, removed: remaining < 1e-8 };
}

/**
 * Mirror a FILLED real buy so the guardian monitors the real holding (and can
 * emit TP/SL exit intents for it). No virtual balance is debited — the tokens
 * were bought with real funds, so only the position is tracked here.
 *
 * A real fill REPLACES any existing position for that token rather than adding
 * to it. Mixing them averaged a paper entry and a real entry into one
 * avgBuyPrice, so every later PnL/SL/TP decision ran against a cost basis that
 * belonged to neither trade — and the guardian then tried to sell the combined
 * amount while the wallet only held the real part. In real mode the ledger is a
 * mirror of on-chain reality, so on-chain wins outright.
 */
export function addMirroredPosition(userId, { tokenAddress, symbol, name, chainId, tokens, price }) {
  if (typeof tokenAddress !== 'string' || !tokenAddress) return null;
  const qty = Number(tokens);
  const px = Number(price);
  if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_TOKEN_AMOUNT) return null;
  if (!Number.isFinite(px) || px <= 0 || px > MAX_TOKEN_PRICE) return null;
  const w = walletFor(userId);
  const existing = w.positions.get(tokenAddress);
  w.positions.set(tokenAddress, {
    // Keep identity metadata so the guardian keeps tracking the same token, but
    // reset the economics to the real fill alone.
    ...(existing ?? {}),
    symbol: symbol ?? existing?.symbol ?? 'UNKNOWN',
    name: name ?? existing?.name ?? '',
    chainId: chainId ?? existing?.chainId ?? 'base',
    amount: qty,
    avgBuyPrice: px,
    totalCost: qty * px,
    currentPrice: px,
    highestPrice: Math.max(Number(existing?.highestPrice) || px, px),
    tp1Hit: false,
    openedAt: existing?.openedAt ?? Date.now(),
  });
  saveUserState(userId);
  return w.positions.get(tokenAddress);
}

export function resetWallet(userId, newInitialBalance) {
  const prev = wallets.get(userId);
  const amount = Number.isFinite(newInitialBalance) && newInitialBalance > 0
    ? Math.min(1_000_000, newInitialBalance) // cap $1M biar tidak kebablasan
    : (prev?.initialBalance ?? INITIAL_BALANCE);
  wallets.set(userId, {
    balance: amount,
    initialBalance: amount,
    positions: new Map(),
    orders: [],
    nextOrderId: 1,
    realizedPnl: 0, // a reset account has earned nothing yet
  });
  saveUserState(userId);
  return getWallet(userId);
}

export function getPositions(userId) {
  const w = walletFor(userId);
  const out = [];
  for (const [addr, p] of w.positions) {
    const clean = sanitizePosition({ ...p, tokenAddress: addr });
    if (clean) out.push(clean); // corrupt rows are omitted, never rendered
  }
  return out;
}

export function getOrders(userId) {
  // Sanitized for the same reason as getOrdersPage — legacy SELL rows lack
  // `amount`/`usdAmount`, and CSV/consumers must never see undefined fields.
  return walletFor(userId).orders.map(sanitizeOrder).filter(Boolean);
}

/** Sanitize a raw order from persistence — defensive against corrupted/legacy records. */
function sanitizeOrder(o) {
  if (!o || typeof o.id !== 'string') return null;
  const side = (o.side === 'buy' || o.side === 'sell') ? o.side : 'buy';
  const amount = Number(o.amount);
  const price = Number(o.price);
  const usdAmount = Number(o.usdAmount);
  const tokenAddress = typeof o.tokenAddress === 'string' ? o.tokenAddress : '';
  const symbol = typeof o.symbol === 'string' ? o.symbol : 'UNKNOWN';
  const chainId = typeof o.chainId === 'string' ? o.chainId : 'base';
  const type = (o.type === 'market' || o.type === 'limit') ? o.type : 'market';
  const status = (o.status === 'filled' || o.status === 'open' || o.status === 'cancelled') ? o.status : 'filled';
  const createdAt = Number.isFinite(o.createdAt) ? o.createdAt : Date.now();
  const filledAt = Number.isFinite(o.filledAt) ? o.filledAt : null;

  // Derive usdAmount if missing (old SELL orders have null usdAmount)
  const derivedUsd = (side === 'sell' && !Number.isFinite(usdAmount)) ? amount * price : usdAmount;

  // Discard orders with no valid amount/price — they cannot be displayed meaningfully.
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price <= 0) return null;

  return {
    id: o.id,
    side,
    tokenAddress,
    chainId,
    symbol,
    name: o.name ?? '',
    amount: Math.min(1e30, Math.max(0, amount)), // clamp extreme values
    price: Math.min(1e12, Math.max(0, price)),
    usdAmount: Number.isFinite(derivedUsd) ? derivedUsd : 0,
    status: status,
    type,
    createdAt,
    filledAt,
  };
}

/** Newest-first page for UI requests; full history remains available for CSV. */
export function getOrdersPage(userId, { limit = 100, offset = 0 } = {}) {
  const all = walletFor(userId).orders;
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  // Sanitize and drop corrupted orders
  const clean = all.map(sanitizeOrder).filter(Boolean);
  return {
    orders: clean.slice(safeOffset, safeOffset + safeLimit),
    total: clean.length,
    limit: safeLimit,
    offset: safeOffset,
    hasMore: safeOffset + safeLimit < clean.length,
  };
}

/** All userIds that have touched a wallet (used by background loops). */
export function listUsers() {
  return [...wallets.keys()];
}

export function executeMarketOrder(userId, { side, tokenAddress, chainId, symbol, name, usdAmount, tokenAmount, currentPrice }) {
  const w = walletFor(userId);
  const id = uid(w);
  const now = Date.now();

  const numPrice = finitePositive(currentPrice, 'currentPrice', MAX_TOKEN_PRICE);
  const requestedTokens = Number(tokenAmount);
  let numTokens; // resolved per side below; also recorded on the order
  let numUsd; // BUY input, or SELL proceeds derived from tokens × price

  if (side === 'buy') {
    numUsd = finitePositive(usdAmount, 'usdAmount', MAX_VIRTUAL_USD);
    numTokens = (!Number.isFinite(requestedTokens) || requestedTokens <= 0)
      ? finitePositive(numUsd / numPrice, 'tokenAmount', MAX_TOKEN_AMOUNT)
      : finitePositive(requestedTokens, 'tokenAmount', MAX_TOKEN_AMOUNT);

    const cost = numUsd;
    // Reserved USD for open buy limits is committed — a market buy must respect it.
    const reservedUsd = w.orders
      .filter((o) => o.type === 'limit' && o.side === 'buy' && o.status === 'open')
      .reduce((s, o) => s + (Number(o.usdAmount) || 0), 0);
    if (cost + reservedUsd > w.balance) {
      throw new Error(`Saldo tidak cukup. Butuh $${cost.toFixed(2)} + $${reservedUsd.toFixed(2)} tereservasi limit order, tersedia $${w.balance.toFixed(2)} USDC`);
    }
    w.balance -= cost;
    const existing = w.positions.get(tokenAddress);
    if (existing) {
      const newAmount = Math.min(MAX_TOKEN_AMOUNT, (Number(existing.amount) || 0) + numTokens);
      const newTotalCost = Math.min(MAX_VIRTUAL_USD, (Number(existing.totalCost) || 0) + cost);
      w.positions.set(tokenAddress, {
        ...existing,
        amount: newAmount,
        avgBuyPrice: newAmount > 0 ? newTotalCost / newAmount : numPrice,
        totalCost: newTotalCost,
        currentPrice: numPrice,
        highestPrice: Math.max(Number(existing.highestPrice) || numPrice, numPrice),
      });
    } else {
      w.positions.set(tokenAddress, {
        symbol: symbol ?? 'UNKNOWN',
        name: name ?? '',
        chainId: chainId ?? 'base',
        amount: numTokens,
        avgBuyPrice: numPrice,
        totalCost: cost,
        currentPrice: numPrice,
        highestPrice: numPrice,
        tp1Hit: false,
        openedAt: now, // used by autopilot stagnant-rotation
      });
    }
  } else {
    const existing = w.positions.get(tokenAddress);
    if (!existing) throw new Error('Tidak ada posisi untuk token ini di portfolio');
    const curAmount = Number(existing.amount) || 0;
    // SELL: tokenAmount is required; usdAmount is derived.
    // Assign the OUTER numTokens (never re-declare) — the order record below
    // reads it, and a shadowing `const` left it undefined so every SELL order
    // was written with amount=undefined and then dropped by sanitizeOrder.
    numTokens = finitePositive(requestedTokens, 'tokenAmount', MAX_TOKEN_AMOUNT);
    if (!Number.isFinite(numTokens) || numTokens <= 0 || numTokens > curAmount + 1e-6) {
      throw new Error(`Jumlah token dijual tidak valid (maks ${curAmount})`);
    }
    // Reserved tokens for open sell limits are committed — market sell must respect them.
    const reservedTokens = w.orders
      .filter((o) => o.type === 'limit' && o.side === 'sell' && o.status === 'open' && o.tokenAddress === tokenAddress)
      .reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const sellable = Math.max(0, curAmount - reservedTokens);
    if (numTokens > curAmount + 1e-6) {
      throw new Error(`Jumlah jual melebihi posisi. Miliki ${curAmount.toFixed(4)}, order ${numTokens.toFixed(4)}`);
    }
    if (numTokens > sellable + 1e-6) {
      throw new Error(`Jumlah jual melebihi posisi yang tersedia. Miliki ${curAmount.toFixed(4)}, ${reservedTokens.toFixed(4)} tereservasi limit order, ${sellable.toFixed(4)} bisa dijual market`);
    }
    const sellQty = Math.min(numTokens, curAmount);
    numUsd = sellQty * numPrice; // proceeds — used for the order record
    const revenue = sellQty * numPrice;
    // Cap the credit so a corrupt position size can never inflate the balance
    // into absurd territory (the 7.18e+45 incident).
    w.balance = Math.min(MAX_VIRTUAL_USD, w.balance + revenue);
    const avgBuy = Number(existing.avgBuyPrice) || numPrice;
    const realized = revenue - (sellQty * avgBuy);
    updateRealizedPnl(w, realized);

    const remaining = curAmount - sellQty;
    if (remaining < 1e-8) {
      w.positions.delete(tokenAddress);
    } else {
      w.positions.set(tokenAddress, {
        ...existing,
        amount: remaining,
        totalCost: Math.max(0, (Number(existing.totalCost) || 0) - (sellQty * avgBuy)),
        currentPrice: numPrice,
      });
    }
  }

  const order = {
    id,
    type: 'market',
    side,
    tokenAddress,
    chainId: chainId ?? 'base',
    symbol: symbol ?? 'UNKNOWN',
    name: name ?? '',
    amount: numTokens,
    price: numPrice,
    usdAmount: side === 'buy' ? numUsd : numTokens * numPrice,
    status: 'filled',
    createdAt: now,
    filledAt: now,
  };
  w.orders.unshift(order);
  saveUserState(userId);
  return order;
}

export function createLimitOrder(userId, { side, tokenAddress, chainId, symbol, name, targetPrice, usdAmount, tokenAmount }) {
  const w = walletFor(userId);
  const numTarget = finitePositive(targetPrice, 'targetPrice', MAX_TOKEN_PRICE);
  const numUsd = finitePositive(usdAmount, 'usdAmount', MAX_VIRTUAL_USD);
  const numTokens = finitePositive(tokenAmount, 'tokenAmount', MAX_TOKEN_AMOUNT);

  if (side === 'buy') {
    const cost = numUsd;
    const reserved = w.orders
      .filter((o) => o.type === 'limit' && o.side === 'buy' && o.status === 'open')
      .reduce((s, o) => s + (Number(o.usdAmount) || 0), 0);
    if (cost + reserved > w.balance) {
      throw new Error(`Saldo tidak cukup. Butuh $${cost.toFixed(2)} + $${reserved.toFixed(2)} tereservasi limit order, tersedia $${w.balance.toFixed(2)} USDC`);
    }
  } else {
    const existing = w.positions.get(tokenAddress);
    if (!existing) throw new Error('Tidak ada posisi untuk token ini di portfolio');
    const curAmount = Number(existing.amount) || 0;
    const reservedTokens = w.orders
      .filter((o) => o.type === 'limit' && o.side === 'sell' && o.status === 'open' && o.tokenAddress === tokenAddress)
      .reduce((s, o) => s + (Number(o.amount) || 0), 0);
    if (numTokens + reservedTokens > curAmount + 1e-6) {
      throw new Error(`Jumlah jual melebihi posisi. Miliki ${curAmount.toFixed(4)}, order ${numTokens.toFixed(4)} (${reservedTokens.toFixed(4)} tereservasi limit order)`);
    }
  }

  const id = uid(w);
  const now = Date.now();
  const order = {
    id,
    type: 'limit',
    side,
    tokenAddress,
    chainId: chainId ?? 'base',
    symbol: symbol ?? 'UNKNOWN',
    name: name ?? '',
    amount: numTokens,
    targetPrice: numTarget,
    price: numTarget,
    usdAmount: numUsd,
    status: 'open',
    createdAt: now,
    filledAt: null,
  };
  w.orders.unshift(order);
  saveUserState(userId);
  return order;
}

export function cancelOrder(userId, orderId) {
  const w = walletFor(userId);
  const idx = w.orders.findIndex((o) => o.id === orderId);
  if (idx === -1) throw new Error('Order tidak ditemukan');
  if (w.orders[idx].status !== 'open') throw new Error('Hanya order open yang bisa dibatalkan');
  w.orders[idx].status = 'cancelled';
  w.orders[idx].filledAt = null;
  saveUserState(userId);
  return w.orders[idx];
}

export function checkLimitOrders(userId, currentPrices) {
  const w = walletFor(userId);
  const filled = [];
  for (const order of [...w.orders]) {
    if (order.status !== 'open') continue;
    const currentPrice = currentPrices.get(order.tokenAddress.toLowerCase());
    if (currentPrice == null) continue;
    const numPrice = Number(currentPrice) || 0;
    // A bad upstream tick must not fill an order at an absurd price.
    if (!Number.isFinite(numPrice) || numPrice <= 0 || numPrice > MAX_TOKEN_PRICE) continue;
    const shouldFill =
      (order.side === 'buy' && numPrice <= order.targetPrice) ||
      (order.side === 'sell' && numPrice >= order.targetPrice);

    if (shouldFill) {
      order.status = 'filled';
      order.filledAt = Date.now();
      order.price = numPrice;
      try {
        const result = executeMarketOrder(userId, {
          side: order.side,
          tokenAddress: order.tokenAddress,
          chainId: order.chainId,
          symbol: order.symbol,
          name: order.name,
          usdAmount: order.usdAmount,
          // Buy limits commit USD and receive whatever it buys at the fill price;
          // sell limits commit an exact token quantity.
          tokenAmount: order.side === 'buy' ? undefined : order.amount,
          currentPrice: numPrice,
        });
        filled.push({ order, result });
      } catch (e) {
        order.status = 'cancelled';
        order.filledAt = null;
        filled.push({ order, error: e.message });
      }
    }
  }
  if (filled.length > 0) saveUserState(userId);
  return filled;
}