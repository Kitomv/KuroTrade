// Trading dashboard backend — Express 5 ESM
// Proxies DexScreener REST, caches 15s, owns watchlist + price history.
// Multi-user: Bearer-token auth, per-user persisted state.

import express from 'express';
import { ethers } from 'ethers';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';
import { dexscreener } from './dexscreener.js';
import { runTickWithDeadline, TICK_DEADLINE, TICK_BUSY } from './tickGuard.js';
import {
  addWatchlist, removeWatchlist, getWatchlist,
  pushHistory, getHistory,
} from './store.js';
import {
  getWallet, resetWallet, getPositions, getOrders, getOrdersPage,
  executeMarketOrder, createLimitOrder, cancelOrder, checkLimitOrders, updatePositionPrices,
  initWallet, listUsers,
} from './wallet.js';
import {
  analyzeToken, scanMarketSignals, setAutopilot, getAutopilot, runAutopilotTick, clearAutopilotLogs,
  initAutopilot,
} from './aiAgent.js';
import { getLLMConfig, setLLMConfig, listModels, testConnection } from './llmClient.js';
import { subscribeUser, pushForUser, pushLlmForUser } from './agentStream.js';
import { evaluateBuyGate } from './buyGate.js';
import {
  isRealMode, setRealMode,
  getRealIntents, getRealIntent, setRealIntentStatus, addRealIntent,
  getBoundWallet, bindWallet, assertBoundWallet, createBindChallenge,
} from './realIntent.js';
import { verifyUser, createSession, getUser, destroySession, seedAdminFromEnv,
  changePassword, destroyOtherSessions, listUsers as listAuthUsers, getUserById,
  roleOf, isAdmin, listAccounts, setUserPassword, createUser } from './auth.js';
import { flushAll, cleanupTempFiles, DATA_DIR } from './persistence.js';
import { securityHeaders, redact, sanitizeError, ipRateLimit, userRateLimit, isSafeBaseUrl } from './security.js';
import { createCors } from './cors.js';
import { createLoginGuard } from './loginGuard.js';
import {
  listEvmChains, isSupportedChain, getChainConfig, getEvmBalanceNative,
  getEvmTokenValue, getNativeUsdPrice, evmQuote, buildSwapTx, resolveSwapParams,
  resolveTokenDecimals, isAllowedRouter, getBoundEvmAddress,
} from './evmWallet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Security headers before body parsing/CORS, so malformed or oversized requests
// still receive defensive response headers.
app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));

// Behind a hosting edge (Railway) the socket peer is the edge, not the client.
// Railway delivers `X-Forwarded-For: <client>, <internal hop>` — probed live,
// the rightmost entry is the same address for unrelated clients (shared
// infrastructure), so trusting ONE hop resolves `req.ip` to it and ten failed
// logins from anyone lock the login route for every visitor. Two hops lands on
// the client the edge observed; the edge strips client-supplied forwarding
// headers and the app is unreachable except through it, so it cannot be
// forged. src/trustProxy.test.mjs pins this shape — re-run it if the platform
// changes.
app.set('trust proxy', 2);

// CORS — localhost dev origins are allowed only when the connection itself
// came from loopback; the deployed frontend origin (Vercel) is named via
// ALLOWED_ORIGINS. Malformed entries are reported loudly because the failure
// they cause — a browser CORS block — never reaches this server, so it leaves
// no trace in the logs.
const { corsMiddleware, droppedOrigins } = createCors(process.env.ALLOWED_ORIGINS);
if (droppedOrigins.length > 0) {
  console.warn(`[cors] ALLOWED_ORIGINS entries diabaikan (bukan origin yang valid): ${droppedOrigins.join(', ')}`);
}
app.use(corsMiddleware);

// --- Auth middleware: resolves req.userId from Bearer token ---
// Guards ONLY /api/* data routes. Static frontend (/, /assets/*) stays public —
// the SPA gate handles auth client-side; blocking assets would blank the app.
// Only password login is pre-auth: there is no self-registration, so /api/login
// is the single door into the app and the admin routes below are the only way
// to add anyone.
const PUBLIC_PATHS = new Set([
  '/api/login',
  '/api/health',
]);
app.use((req, res, next) => {
  // Express path matching is case-insensitive, so /API/portfolio reaches the
  // same route as /api/portfolio. Compare lowercased, or the guard is bypassed.
  const p = req.path.toLowerCase();
  if (req.method === 'OPTIONS' || !p.startsWith('/api/') || PUBLIC_PATHS.has(p)) return next();
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const userId = getUser(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  req.token = token;
  next();
});

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(redact(err));
    // Route handlers may throw a deliberate 4xx/5xx. Don't mislabel every
    // validation/auth error as an upstream 502, and don't expose raw internals.
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
      ? err.status
      : (err?.code === 'UPSTREAM_ERROR' ? 502 : 500);
    res.status(status).json({ error: sanitizeError(err?.message ?? err) });
  });
};

// --- Auth routes ---
// Per-IP guards on the routes reachable without (or before) a valid session,
// or that can burn money/upstream quota. The per-user rateLimit() below is
// keyed by req.userId and cannot stop distributed floods or pre-auth probing.
const loginLimiter = ipRateLimit({ max: 20, windowMs: 60_000 });
// Post-auth, keyed by userId. The dashboard polls ~10 distinct /api/real
// endpoints (hot-wallet status/auto/pause/balance, intents, mode, auto, bound)
// — at 15s each that is ~40 req/min, so 300 leaves generous headroom for
// manual actions without ever tripping during normal use.
app.use('/api/real', userRateLimit({ max: 300, windowMs: 60_000 }));
app.use('/api/llm', ipRateLimit({ max: 30, windowMs: 60_000 }));    // config saves + provider probes

// Simple brute-force guard: max 10 failed logins per 5 minutes, counted BOTH
// per client IP (one host hammering the route) and per username (a botnet
// spraying one account from many IPs — the per-IP counter alone never trips
// for any single attacker host). A successful login clears both. The window
// is short on purpose: a locked-out username recovers in minutes.
const loginIpGuard = createLoginGuard({ max: 10, windowMs: 5 * 60 * 1000 });
const loginUserGuard = createLoginGuard({ max: 10, windowMs: 5 * 60 * 1000 });

app.post('/api/login', loginLimiter, (req, res) => {
  const ip = req.ip ?? 'unknown';
  const { username, password } = req.body ?? {};
  // Usernames are matched case-sensitively by verifyUser; the guard key
  // lowercases so casing tricks cannot spread failures across buckets.
  const userKey = typeof username === 'string' ? username.toLowerCase() : '';
  if (loginIpGuard.blocked(ip) || loginUserGuard.blocked(userKey)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
  }
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = verifyUser(String(username), String(password));
  if (!user) {
    loginIpGuard.noteFailure(ip);
    loginUserGuard.noteFailure(userKey);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  loginIpGuard.clear(ip);
  loginUserGuard.clear(userKey);
  const token = createSession(user.id);
  res.json({ token, userId: user.id, username: user.username, role: roleOf(user) });
});

// --- Admin: the only account-creation path ---
// An admin adds users; nothing else can mint an account. The role is re-read
// from disk on every request (never trusted from the token), so revoking an
// admin takes effect on the next call rather than at session expiry.
function requireAdmin(req, res, next) {
  if (!isAdmin(req.userId)) return res.status(403).json({ error: 'Khusus admin' });
  // The account list is an identity table (usernames + addresses). Express sets
  // an ETag by default and a shared/kiosk browser may retain it, so every admin
  // response is explicitly uncacheable.
  res.set('Cache-Control', 'no-store');
  next();
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: listAccounts() });
});

app.post('/api/admin/users', requireAdmin, ipRateLimit({ max: 10, windowMs: 60_000 }), (req, res) => {
  const { username, password } = req.body ?? {};
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name || !password) return res.status(400).json({ error: 'username and password required' });
  if (name.length < 3 || name.length > 32) return res.status(400).json({ error: 'Username harus 3–32 karakter' });
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return res.status(400).json({ error: 'Username hanya boleh huruf, angka, titik, garis bawah, dan strip' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const user = createUser(name, String(password), 'user');
  if (!user) return res.status(409).json({ error: 'Username sudah dipakai' });
  res.status(201).json({ id: user.id, username: user.username, role: roleOf(user), createdAt: user.createdAt });
});

app.post('/api/admin/users/:id/password', requireAdmin, ipRateLimit({ max: 20, windowMs: 60_000 }), (req, res) => {
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  if (!setUserPassword(req.params.id, String(password))) {
    return res.status(404).json({ error: 'User tidak ditemukan' });
  }
  // A reset exists to cut off access — leaving the old sessions alive would
  // let whoever held the account keep using it until the token expired.
  destroyOtherSessions(req.params.id, '');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) destroySession(auth.slice(7));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUserById(req.userId);
  res.json({
    userId: req.userId,
    username: user?.username ?? '',
    // Read from disk, not from the token: a demoted admin loses the Admin page
    // on the next load instead of keeping it until the session expires.
    role: roleOf(user),
    address: user?.address ?? getBoundWallet(req.userId),
    wallet: getWallet(req.userId),
  });
});

app.post('/api/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password baru minimal 8 karakter' });
  try {
    changePassword(req.userId, String(currentPassword), String(newPassword));
    destroyOtherSessions(req.userId, req.token); // keep this session, kill the rest
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Leaderboard (all users ranked by portfolio value) ---
app.get('/api/leaderboard', (req, res) => {
  const rows = listAuthUsers().map((u) => {
    const w = getWallet(u.id);
    return {
      userId: u.id,
      username: u.username,
      totalValue: w.totalValue,
      pnlPct: Math.round(((w.totalValue - w.initialBalance) / w.initialBalance) * 10000) / 100,
      positionsCount: getPositions(u.id).length,
    };
  }).sort((a, b) => b.totalValue - a.totalValue);
  res.json(rows);
});

// --- Real trading: EVM (1inch proxy — the server never signs) ---
// The backend builds the UNSIGNED tx; MetaMask signs it in the browser via
// eth_sendTransaction. No private key touches this process.

/** EVM address shape, shared by the quote/swap/bind routes below. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Reject an unknown chain before it reaches 1inch or the RPC layer. */
function resolveChain(res, value) {
  const chain = String(value ?? 'base').toLowerCase();
  if (!isSupportedChain(chain)) {
    res.status(400).json({ error: `Chain "${chain}" tidak didukung` });
    return null;
  }
  return chain;
}

app.get('/api/real/evm/chains', (_req, res) => {
  res.json({ chains: listEvmChains() });
});

app.post('/api/real/quote', rateLimit('quote', 20), wrap(async (req, res) => {
  const { src, dst, amount } = req.body ?? {};
  const chain = resolveChain(res, req.body?.chain);
  if (!chain) return;
  if (!EVM_ADDRESS_RE.test(String(src)) || !EVM_ADDRESS_RE.test(String(dst))) {
    return res.status(400).json({ error: 'src/dst harus alamat 0x + 40 hex (native = 0xEeee…EEeE)' });
  }
  if (src.toLowerCase() === dst.toLowerCase()) {
    return res.status(400).json({ error: 'src dan dst tidak boleh sama' });
  }
  res.json(await evmQuote({ src, dst, amount, chain }));
}));

// Token decimals for SELL atomic-unit conversion. Resolved on-chain from the
// token contract (authoritative) — never guessed: 9 for a 6-decimal token
// over-sells by 1000x.
app.get('/api/real/evm/decimals', rateLimit('quote', 60), wrap(async (req, res) => {
  const chain = resolveChain(res, req.query.chain);
  if (!chain) return;
  const token = String(req.query.token ?? '');
  if (!EVM_ADDRESS_RE.test(token)) return res.status(400).json({ error: 'token harus alamat 0x + 40 hex' });
  const decimals = await resolveTokenDecimals(token, chain);
  if (decimals === null) return res.status(404).json({ error: 'Gagal resolve desimal token — sell ditolak (mencegah salah unit)' });
  res.json({ token, chain, decimals });
}));

app.post('/api/real/swap-tx', rateLimit('quote', 20), wrap(async (req, res) => {
  // Intent-bound swap: the server rebuilds the swap from the STORED intent
  // (side, token, amount, slippage) — the client cannot control what gets
  // signed. The manual path additionally requires a bound wallet.
  const { intentId, from } = req.body ?? {};
  const chain = resolveChain(res, req.body?.chain);
  if (!chain) return;
  if (!EVM_ADDRESS_RE.test(String(from))) return res.status(400).json({ error: 'from harus alamat 0x + 40 hex' });
  try { assertBoundWallet(req.userId, String(from)); } catch (e) { return res.status(403).json({ error: e.message }); }

  if (!intentId) return res.status(400).json({ error: 'intentId required' });
  const intent = getRealIntent(req.userId, intentId);
  if (!intent) return res.status(404).json({ error: 'Intent tidak ditemukan' });
  if (intent.status !== 'active') return res.status(409).json({ error: 'Intent tidak aktif / sudah diklaim sesi lain' });

  const intentChain = String(intent.chainId ?? chain).toLowerCase();
  if (!isSupportedChain(intentChain)) {
    return res.status(400).json({ error: `Intent dibuat untuk chain "${intentChain}" yang tidak didukung` });
  }

  // Which assets move. Pure decision (see resolveSwapParams): buys pay with
  // USDT when the intent says so, sells target USDT so proceeds return to the
  // funding currency.
  let legs;
  try {
    legs = resolveSwapParams(intent, intentChain);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { src, dst, amountKind } = legs;

  let amount;
  if (amountKind === 'nativeWei') {
    const wei = String(intent.amountWei ?? '');
    // Never fall back to treating a USD budget as native. An intent without a
    // resolved wei amount predates the EVM migration and is unsafe to fill.
    if (!/^\d+$/.test(wei) || wei === '0') {
      return res.status(400).json({ error: 'Intent buy tanpa amountWei — buat ulang intent (unit lama tidak aman)' });
    }
    amount = wei;
  } else if (amountKind === 'usd') {
    // USDT is $1 throughout the codebase, so the USD budget IS the funding
    // amount. Decimals are resolved ON-CHAIN per chain — BSC USDT has 18,
    // every other chain's has 6, and assuming either would be off by 1e12.
    const decimals = await resolveTokenDecimals(src, intentChain);
    if (decimals === null) {
      return res.status(400).json({ error: 'Gagal resolve desimal USDT — buy ditolak (mencegah salah unit)' });
    }
    // toFixed before parseUnits: amountUsd is a JS float and String(0.1+0.2)
    // is "0.30000000000000004", which parseUnits rejects as too many decimals.
    const atomic = ethers.parseUnits(Number(intent.amountUsd).toFixed(decimals), decimals);
    if (atomic <= 0n) return res.status(400).json({ error: 'Jumlah buy USDT tidak valid' });
    amount = atomic.toString();
  } else {
    const decimals = await resolveTokenDecimals(intent.tokenAddress, intentChain);
    if (decimals === null) {
      return res.status(400).json({ error: 'Gagal resolve desimal token — sell ditolak (mencegah salah unit)' });
    }
    const atomic = ethers.parseUnits(String(intent.estTokens), decimals);
    if (atomic <= 0n) return res.status(400).json({ error: 'Jumlah sell tidak valid' });
    amount = atomic.toString();
  }

  // Slippage: 1 percent, fixed server-side — the intent path never lets the
  // client widen it. (1inch v6 takes percent, not bps.)
  const built = await buildSwapTx({ src, dst, amount, chain: intentChain, from, slippage: 1 });
  res.json({ ...built, intentId });
}));

// Manual trade request → a normal intent. Deliberately NOT a separate execution
// path: routing the user's own clicks through the same intent state machine
// means they inherit every guard (per-trade cap, affordability, claim tokens,
// buy/sell dedup, chain allow-list) instead of a parallel path that would need
// its own copies and could drift.
app.post('/api/real/manual-intent', rateLimit('quote', 20), wrap(async (req, res) => {
  const { tokenAddress, symbol, side, amountUsd, estTokens, intentPrice } = req.body ?? {};
  const chain = resolveChain(res, req.body?.chain);
  if (!chain) return;
  if (!EVM_ADDRESS_RE.test(String(tokenAddress))) {
    return res.status(400).json({ error: 'tokenAddress harus alamat 0x + 40 hex' });
  }
  if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'side harus "buy" atau "sell"' });

  const address = getBoundEvmAddress(req.userId);
  if (!address) return res.status(403).json({ error: 'Wallet belum di-bind — bind MetaMask dulu' });

  const tokens = Number(estTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return res.status(400).json({ error: 'estTokens harus > 0' });
  const price = Number(intentPrice);
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'intentPrice harus > 0' });
  const usd = Number(amountUsd);
  if (!Number.isFinite(usd) || usd <= 0) return res.status(400).json({ error: 'amountUsd harus > 0' });

  // Dedup: two open intents for the same token+side is how a double-click turns
  // into two real on-chain trades once both are approved.
  const dup = getRealIntents(req.userId).some(
    (i) => (i.status === 'open' || i.status === 'active')
      && i.side === side
      && String(i.tokenAddress).toLowerCase() === String(tokenAddress).toLowerCase(),
  );
  if (dup) return res.status(409).json({ error: 'Sudah ada intent untuk token ini yang menunggu approve' });

  const intent = { symbol: String(symbol ?? 'UNKNOWN').slice(0, 40), tokenAddress, chainId: chain, side, source: 'MANUAL', amountUsd: usd, estTokens: tokens, intentPrice: price };

  if (side === 'buy') {
    const { getNativeUsdPrice, checkTradeSize, pickBuyFunding } = await import('./evmWallet.js');
    const capped = checkTradeSize(usd);
    const effectiveUsd = capped.ok ? usd : capped.cap;
    // Same funding preference as the autopilot: USDT when it covers the buy
    // and the native gas reserve survives, else native.
    const pick = await pickBuyFunding(address, effectiveUsd, chain);
    if (!pick.funding) {
      const native = getChainConfig(chain).native;
      return res.status(400).json({
        error: `Wallet tidak sanggup beli $${effectiveUsd} (${pick.reason}). USDT ${pick.usdtBalance === null ? 'n/a' : pick.usdtBalance.toFixed(2)}, ${native} ${Number(pick.nativeBalance || 0).toFixed(6)} (cadangan gas ${pick.gasReserve})`,
      });
    }
    intent.fundingToken = pick.funding;
    intent.amountUsd = Math.round(effectiveUsd * 100) / 100;
    // Same pre-quote risk gate the scout runs: the daily-loss cap and the
    // token-quality checks (honeypot sell ratio, thin liquidity, thin float)
    // must stop a hand-clicked buy too, not just an autopilot one. Metrics come
    // from DexScreener; a token with no market data fails closed.
    const market = await dexscreener.token(tokenAddress, chain).catch(() => null);
    const gate = evaluateBuyGate({
      userId: req.userId,
      usdAmount: intent.amountUsd,
      token: market
        ? { liquidityUsd: market.liquidityUsd, fdv: market.fdv, txns24h: market.txns24h }
        : null,
    });
    if (!gate.ok) {
      return res.status(400).json({ error: `Ditolak risk guard (${gate.code}): ${gate.message}` });
    }
    if (pick.funding === 'native') {
      const nativeUsd = await getNativeUsdPrice(chain);
      if (!nativeUsd || nativeUsd <= 0) {
        return res.status(400).json({ error: `Harga ${getChainConfig(chain).native} tidak tersedia — coba lagi` });
      }
      intent.amountWei = Math.round((intent.amountUsd / nativeUsd) * 1e18);
    }
    // USDT funding needs no amountWei: the swap-tx builder converts amountUsd
    // at the USDT contract's own decimals (18 on BSC, 6 elsewhere).
  } else {
    // Cost basis snapshot for the realized-PnL booking at confirmation time.
    const { getPositions } = await import('./wallet.js');
    const pos = getPositions(req.userId).find(
      (p) => p.tokenAddress.toLowerCase() === String(tokenAddress).toLowerCase(),
    );
    intent.entryAvgPrice = Number(pos?.avgBuyPrice) || price;
  }

  const created = addRealIntent(req.userId, intent);
  res.status(201).json(created);
}));

// Wallet binding: a single-use nonce challenge so a captured signature cannot
// be replayed. The client signs the exact message with MetaMask (personal_sign);
// bindWallet consumes the nonce exactly once and stores the RECOVERED address.
app.get('/api/real/bind-message', rateLimit('bind', 10), (req, res) => {
  const address = String(req.query.address ?? req.query.publicKey ?? '');
  if (!EVM_ADDRESS_RE.test(address)) return res.status(400).json({ error: 'address harus 0x + 40 hex' });
  res.json(createBindChallenge(req.userId, address));
});

app.post('/api/real/bind', rateLimit('bind', 10), async (req, res) => {
  const address = String(req.body?.address ?? req.body?.publicKey ?? '');
  const signature = req.body?.signature;
  if (!address || !signature) return res.status(400).json({ error: 'address & signature required' });
  if (!EVM_ADDRESS_RE.test(address)) return res.status(400).json({ error: 'address harus 0x + 40 hex' });
  try {
    res.json(bindWallet(req.userId, address, String(signature)));
  } catch (e) {
    // Signature/address validation is a client input error, not a proxy failure.
    res.status(400).json({ error: e.message ?? 'Signature wallet tidak valid' });
  }
});

// Current binding status (for the UI's "Wallet ter-bind" indicator).
app.get('/api/real/bound', (req, res) => {
  res.json({ boundWallet: getBoundWallet(req.userId) });
});

// --- CSV export ---
function csvEscape(v) {
  // Prefix ' when a cell starts with a formula trigger to neutralize
  // Excel/Sheets formula injection (= + - @ tab cr), then apply CSV quoting.
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}

app.get('/api/export/orders.csv', (req, res) => {
  const orders = getOrders(req.userId);
  const csv = toCsv(
    ['id', 'createdAt', 'type', 'side', 'symbol', 'tokenAddress', 'amount', 'price', 'usdAmount', 'status'],
    orders.map((o) => [o.id, new Date(o.createdAt).toISOString(), o.type, o.side, o.symbol, o.tokenAddress, o.amount, o.price, o.usdAmount, o.status]),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(csv);
});

app.get('/api/export/positions.csv', (req, res) => {
  const positions = getPositions(req.userId);
  const csv = toCsv(
    ['tokenAddress', 'symbol', 'amount', 'avgBuyPrice', 'currentPrice', 'totalCost', 'unrealizedPnl'],
    positions.map((p) => {
      const cur = Number(p.currentPrice) || Number(p.avgBuyPrice) || 0;
      const unrealized = (Number(p.amount) || 0) * cur - (Number(p.totalCost) || 0);
      return [p.tokenAddress, p.symbol, p.amount, p.avgBuyPrice, cur, p.totalCost, Math.round(unrealized * 100) / 100];
    }),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="positions.csv"');
  res.send(csv);
});

// --- Real-wallet pending intents (autopilot → user approves via MetaMask) ---
app.get('/api/real/intents', (req, res) => {
  // claimToken is a server-side single-flight guard — never expose it to clients.
  res.json(getRealIntents(req.userId).map(({ claimToken, ...rest }) => rest));
});

app.post('/api/real/intents/:id/status', (req, res) => {
  const { status, claimToken } = req.body ?? {};
  if (!['open', 'active', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'status tidak valid' });
  try {
    res.json(setRealIntentStatus(req.userId, req.params.id, status, claimToken ?? null));
  } catch (e) {
    const msg = String(e.message ?? e);
    // Claim conflict → 409 so a second tab can back off instead of double-approving.
    res.status(msg.includes('claimed') || msg.includes('diklaim') ? 409 : 400).json({ error: msg });
  }
});

app.get('/api/real/mode', async (req, res) => {
  const { isRealMode } = await import('./realIntent.js');
  res.json({ realMode: isRealMode(req.userId) });
});

app.post('/api/real/mode', async (req, res) => {
  const { setRealMode } = await import('./realIntent.js');
  const { realMode } = req.body ?? {};
  res.json(setRealMode(req.userId, Boolean(realMode)));
});

// Whether the executor may send ERC-20 approvals on its own. Per-user and
// default-off; see isAutoApprove in realIntent.js. Strictly a BOOLEAN here —
// `setAutoApprove` takes `on === true`, so a truthy string cannot arm spending
// authority through a sloppy client.
app.get('/api/real/auto-approve', async (req, res) => {
  const { isAutoApprove } = await import('./realIntent.js');
  res.json({ autoApprove: isAutoApprove(req.userId) });
});

app.post('/api/real/auto-approve', async (req, res) => {
  const { setAutoApprove } = await import('./realIntent.js');
  const { autoApprove } = req.body ?? {};
  res.json(setAutoApprove(req.userId, autoApprove === true));
});

// Every real trade waits for an explicit signature in MetaMask.
// Default false, persisted per user, forcibly disabled when real mode is off.
// Real-wallet on-chain reads for the BOUND MetaMask address. There is no
// server-held wallet: these are read-only views of the user's own address.
app.get('/api/real/balance', wrap(async (req, res) => {
  const chain = resolveChain(res, req.query.chain);
  if (!chain) return;
  const address = getBoundEvmAddress(req.userId);
  if (!address) return res.status(404).json({ error: 'Wallet belum di-bind' });
  const native = await getEvmBalanceNative(address, chain);
  res.json({ address, chain, native, nativeUsd: await getNativeUsdPrice(chain) });
}));

app.get('/api/real/portfolio', wrap(async (req, res) => {
  const chain = resolveChain(res, req.query.chain);
  if (!chain) return;
  const address = getBoundEvmAddress(req.userId);
  if (!address) return res.status(404).json({ error: 'Wallet belum di-bind' });
  // The tracked token set is the user's own positions — the only holdings the
  // app knows how to price (DexScreener) or value.
  const { getPositions } = await import('./wallet.js');
  const tokens = [...new Set(getPositions(req.userId)
    .filter((p) => p.chainId === chain)
    .map((p) => p.tokenAddress))];
  const { valueUsd, holdings, unpricedCount } = await getEvmTokenValue(address, chain, tokens);
  const nativeUsd = await getNativeUsdPrice(chain);
  const native = await getEvmBalanceNative(address, chain);
  res.json({
    address, chain, native, nativeUsd,
    tokenValueUsd: valueUsd,
    // Holdings the backend could not price at all (decimals unreadable). The
    // panel must treat this as "the total is incomplete", not silently ignore it.
    unpricedCount,
    totalUsd: nativeUsd ? Math.round((native * nativeUsd + valueUsd) * 100) / 100 : null,
    holdings,
  });
}));

// --- Per-user rate limits for heavy AI endpoints ---
const aiLimits = new Map(); // userId -> { analyze: {count, resetAt}, signals: {count, resetAt} }

function rateLimit(kind, maxPerMin) {
  return (req, res, next) => {
    const now = Date.now();
    const rec = aiLimits.get(req.userId) ?? {};
    const entry = rec[kind];
    if (!entry || now > entry.resetAt) {
      rec[kind] = { count: 1, resetAt: now + 60_000 };
    } else if (entry.count >= maxPerMin) {
      return res.status(429).json({ error: `Terlalu banyak permintaan ${kind}. Coba lagi dalam ${Math.ceil((entry.resetAt - now) / 1000)}s.` });
    } else {
      entry.count++;
    }
    aiLimits.set(req.userId, rec);
    next();
  };
}

// --- Trending ---
app.get('/api/trending', wrap(async (req, res) => {
  res.json(await dexscreener.tokenProfiles(Number(req.query.limit) || 30));
}));

// --- Search ---
app.get('/api/search', wrap(async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'q required' });
  res.json(await dexscreener.search(req.query.q));
}));

// --- Watchlist CRUD ---
app.get('/api/watchlist', wrap(async (req, res) => {
  const entries = getWatchlist(req.userId);
  const markets = await dexscreener.tokens(entries.map((e) => e.tokenAddress)).catch(() => new Map());
  const withPrices = entries.map((e) => {
    const token = markets.get(e.tokenAddress.toLowerCase()) ?? null;
    if (token?.priceUsd) pushHistory(req.userId, e.chainId, e.tokenAddress, token.priceUsd);
    return { ...e, market: token };
  });
  res.json(withPrices);
}));

app.post('/api/watchlist', wrap(async (req, res) => {
  const { tokenAddress, chainId, symbol, name, icon } = req.body ?? {};
  if (!tokenAddress || !chainId) {
    return res.status(400).json({ error: 'tokenAddress and chainId required' });
  }
  // Client-supplied display fields: cap length + only allow http(s) icons
  // (rendered into <img src> by the UI).
  const clean = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const safeIcon = typeof icon === 'string' && /^https?:\/\//i.test(icon) ? icon.slice(0, 512) : undefined;
  const key = addWatchlist(req.userId, {
    tokenAddress: String(tokenAddress).slice(0, 128),
    chainId: String(chainId).slice(0, 64),
    symbol: clean(symbol, 64),
    name: clean(name, 64),
    icon: safeIcon,
  });
  res.status(201).json({ key });
}));

app.delete('/api/watchlist/:key', (req, res) => {
  removeWatchlist(req.userId, decodeURIComponent(req.params.key));
  res.status(204).end();
});

app.get('/api/watchlist/:chainId/:tokenAddress/history', (req, res) => {
  res.json(getHistory(req.userId, req.params.chainId, req.params.tokenAddress));
});

// --- Overview KPIs & Market Intelligence ---
app.get('/api/overview', wrap(async (req, res) => {
  const entries = getWatchlist(req.userId);
  const wlMarkets = await dexscreener.tokens(entries.map((e) => e.tokenAddress)).catch(() => new Map());
  const watchlistMarkets = entries.map((e) => wlMarkets.get(e.tokenAddress.toLowerCase())).filter(Boolean);

  let marketMovers = [...watchlistMarkets];
  const seenAddresses = new Set(marketMovers.map((m) => m.tokenAddress.toLowerCase()));

  const hotQueries = ['SOL', 'PEPE', 'BONK', 'AERO', 'ETH', 'RAY', 'DOGE'];
  for (const q of hotQueries) {
    if (marketMovers.length >= 15) break;
    try {
      const searchRes = await dexscreener.search(q, 30_000); // stable hot list → 30s TTL
      for (const pair of searchRes.slice(0, 2)) {
        if (!pair.tokenAddress || seenAddresses.has(pair.tokenAddress.toLowerCase())) continue;
        seenAddresses.add(pair.tokenAddress.toLowerCase());
        marketMovers.push(pair);
        if (marketMovers.length >= 15) break;
      }
    } catch {}
  }

  const allTracked = marketMovers.length > 0 ? marketMovers : watchlistMarkets;
  const totalVolume = allTracked.reduce((s, m) => s + (Number(m.volume24h) || 0), 0);
  const totalLiquidity = allTracked.reduce((s, m) => s + (Number(m.liquidityUsd) || 0), 0);
  const sortedGainers = [...allTracked].sort((a, b) => (Number(b.change24h) || 0) - (Number(a.change24h) || 0));
  const chains = new Set(allTracked.map((m) => m.chainId));

  const wallet = getWallet(req.userId);
  const positions = getPositions(req.userId);

  // Real-wallet on-chain total, valued server-side from the bound MetaMask
  // address across EVERY supported chain. The Portfolio page used to derive
  // the native leg itself by scanning `markets` for the native mint — but
  // `markets` is watchlist + a few hardcoded hot tokens and the mint is not
  // guaranteed to be there, so the total rendered as "—". Server-side pricing
  // is the fix. A base-only query was a second bug: a wallet funded on BSC
  // read as $0.
  let realWalletTotalUsd = null;
  if (isRealMode(req.userId)) {
    try {
      const address = getBoundEvmAddress(req.userId);
      if (address) {
        const { getEvmPortfolioValue, groupTokensByChain } = await import('./evmWallet.js');
        const { getPositions: livePositions } = await import('./wallet.js');
        const portfolio = await getEvmPortfolioValue(address, {
          tokensByChain: groupTokensByChain(livePositions(req.userId)),
        });
        // Unknown (all RPCs failed) must stay null — the UI shows "—", never a
        // false $0.00.
        realWalletTotalUsd = portfolio.pricedChains > 0 ? portfolio.totalUsd : null;
      }
    } catch {}
  }

  res.json({
    watchedTokens: entries.length,
    chainsActive: chains.size,
    totalVolume24h: totalVolume,
    totalLiquidityUsd: totalLiquidity,
    topGainer: sortedGainers[0] ?? null,
    topLoser: sortedGainers[sortedGainers.length - 1] ?? null,
    markets: allTracked,
    watchlistMarkets,
    walletSnapshot: {
      balance: wallet.balance,
      totalValue: wallet.totalValue,
      openPositionsCount: positions.length,
      realWalletTotalUsd,
    },
  });
}));

// --- Wallet & Positions (Realtime price sync) ---
// One batch price-refresh; used by /api/wallet, /api/positions, /api/portfolio.
async function refreshPrices(userId) {
  const allPos = getPositions(userId);
  if (allPos.length === 0) return;
  const m = await dexscreener.tokens(allPos.map((p) => p.tokenAddress)).catch(() => new Map());
  const priceMap = new Map();
  for (const p of allPos) {
    const norm = m.get(p.tokenAddress.toLowerCase());
    if (norm?.priceUsd) priceMap.set(p.tokenAddress, norm.priceUsd);
  }
  updatePositionPrices(userId, priceMap);
}

app.get('/api/wallet', wrap(async (req, res) => {
  await refreshPrices(req.userId);
  res.json(getWallet(req.userId));
}));

app.get('/api/portfolio', wrap(async (req, res) => {
  await refreshPrices(req.userId);
  // Portfolio polls frequently; return only recent orders. CSV/export keeps
  // using getOrders() for the complete history.
  const page = getOrdersPage(req.userId, { limit: 100, offset: 0 });
  res.json({ wallet: getWallet(req.userId), positions: getPositions(req.userId), orders: page.orders, ordersTotal: page.total, ordersHasMore: page.hasMore });
}));

app.post('/api/wallet/reset', (req, res) => {
  const { initialBalance } = req.body ?? {};
  const amount = initialBalance === undefined ? undefined : Number(initialBalance);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    return res.status(400).json({ error: 'initialBalance harus angka > 0' });
  }
  res.json(resetWallet(req.userId, amount));
});

app.get('/api/positions', wrap(async (req, res) => {
  await refreshPrices(req.userId);
  res.json(getPositions(req.userId));
}));

// --- Orders ---
app.get('/api/orders', (req, res) => res.json(getOrders(req.userId)));
app.get('/api/orders/page', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(getOrdersPage(req.userId, { limit, offset }));
});

app.post('/api/orders/market', async (req, res) => {
  try {
    const { side, tokenAddress, chainId, symbol, name, usdAmount, tokenAmount } = req.body ?? {};
    if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side harus "buy" atau "sell"' });
    if (!tokenAddress || String(tokenAddress).length > 100) return res.status(400).json({ error: 'tokenAddress required (max 100 chars)' });
    const usd = Number(usdAmount);
    const toks = Number(tokenAmount);
    if (!Number.isFinite(usd) || usd < 0) return res.status(400).json({ error: 'usdAmount harus angka >= 0' });
    if (!Number.isFinite(toks) || toks < 0) return res.status(400).json({ error: 'tokenAmount harus angka >= 0' });

    let current = await dexscreener.token(tokenAddress).catch(() => null);
    if (!current) {
      const searchRes = await dexscreener.search(symbol || tokenAddress).catch(() => []);
      if (searchRes.length > 0) current = searchRes[0];
    }

    const currentPrice = current?.priceUsd && current.priceUsd > 0
      ? current.priceUsd
      : (usd > 0 && toks > 0 ? usd / toks : 1);

    const order = executeMarketOrder(req.userId, {
      side,
      tokenAddress,
      chainId: chainId ?? current?.chainId ?? 'base',
      symbol: symbol ? String(symbol).slice(0, 40) : (current?.symbol ?? 'UNKNOWN'),
      name: name ? String(name).slice(0, 40) : (current?.name ?? ''),
      usdAmount: usd || 0,
      tokenAmount: toks || 0,
      currentPrice,
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orders/limit', async (req, res) => {
  try {
    const { side, tokenAddress, chainId, symbol, name, targetPrice, usdAmount, tokenAmount } = req.body ?? {};
    if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side harus "buy" atau "sell"' });
    if (!tokenAddress || String(tokenAddress).length > 100) return res.status(400).json({ error: 'tokenAddress required (max 100 chars)' });
    const target = Number(targetPrice);
    if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Target price harus > 0' });
    const usd = Number(usdAmount);
    const toks = Number(tokenAmount);
    if (!Number.isFinite(usd) || usd < 0) return res.status(400).json({ error: 'usdAmount harus angka >= 0' });
    if (!Number.isFinite(toks) || toks < 0) return res.status(400).json({ error: 'tokenAmount harus angka >= 0' });

    const order = createLimitOrder(req.userId, {
      side,
      tokenAddress,
      chainId: chainId ?? 'base',
      symbol: symbol ? String(symbol).slice(0, 40) : 'UNKNOWN',
      name: name ? String(name).slice(0, 40) : '',
      targetPrice: target,
      usdAmount: usd || 0,
      tokenAmount: toks || 0,
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/orders/:id', (req, res) => {
  try {
    res.json(cancelOrder(req.userId, req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- AI Multi-Agent Trading Engine ---
app.post('/api/agents/analyze', rateLimit('analyze', 6), wrap(async (req, res) => {
  const { tokenAddress } = req.body ?? {};
  if (!tokenAddress) return res.status(400).json({ error: 'tokenAddress required' });
  const report = await analyzeToken(req.userId, tokenAddress);
  res.json(report);
}));

app.get('/api/agents/signals', rateLimit('signals', 30), wrap(async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  // Radar's LLM scans only run when autopilot is enabled. The explicit /analyze route is unaffected.
  const signals = await scanMarketSignals(req.userId, limit, { allowStale: true, autopilotEnabled: getAutopilot(req.userId).enabled });
  res.json(signals);
}));

// --- Realtime stream for the Agents page ---
// One long-lived connection replaces the 4s/5s/10s poll trio. Exempt from the
// signals rate limiter on purpose: it is a single connection, not a request
// flood, and the per-tick signal fetch it triggers goes through the same
// scanMarketSignals cache/TLL gate the REST route uses.
app.get('/api/agents/stream', ipRateLimit({ max: 20, windowMs: 60_000 }), (req, res) => {
  try {
    subscribeUser(req.userId, req, res);
  } catch (e) {
    console.warn(`[agents-stream] ${req.userId}: ${sanitizeError(e?.message ?? e)}`);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  }
});

app.get('/api/agents/autopilot', (req, res) => res.json(getAutopilot(req.userId)));
app.post('/api/agents/autopilot', (req, res) => {
  const out = setAutopilot(req.userId, req.body ?? {});
  // The toggle is the most latency-sensitive action on this page: push the new
  // status immediately instead of making the client wait out the next tick.
  pushForUser(req.userId);
  res.json(out);
});
app.post('/api/agents/autopilot/clear-logs', (req, res) => {
  const out = clearAutopilotLogs(req.userId);
  pushForUser(req.userId);
  res.json(out);
});

// --- LLM Cloud Provider Settings (multi-provider per user) ---
app.get('/api/llm/config', (req, res) => res.json(getLLMConfig(req.userId)));
app.post('/api/llm/config', (req, res) => {
  // Accepts a single config {provider, apiKey, model, baseUrl} or an array
  // [{...}, {...}] for a fallback chain / role-routed multi-LLM setup.
  const body = Array.isArray(req.body) ? req.body : req.body ? [req.body] : [];
  for (const entry of body) {
    if (entry && entry.baseUrl && !isSafeBaseUrl(entry.baseUrl)) {
      return res.status(400).json({ error: 'baseUrl tidak diizinkan — hanya http(s), tanpa credential/metadata internal' });
    }
  }
  res.json(setLLMConfig(req.userId, body));
  pushLlmForUser(req.userId);
});

// Model list for the settings combo box — POST so apiKey is in the body,
// never in the URL (logs/history). Mirrors /api/llm/test.
app.post('/api/llm/models', wrap(async (req, res) => {
  const { provider, baseUrl, apiKey } = req.body ?? {};
  if (baseUrl && !isSafeBaseUrl(String(baseUrl))) {
    return res.status(400).json({ error: 'baseUrl tidak diizinkan — hanya http(s), tanpa credential/metadata internal' });
  }
  const models = await listModels(req.userId, {
    provider: provider ? String(provider) : undefined,
    baseUrl: baseUrl ? String(baseUrl) : undefined,
    apiKey: apiKey ? String(apiKey) : undefined,
  });
  res.json({ models });
}));

// Connection probe: /models first, tiny chat fallback. Returns verbatim error.
app.post('/api/llm/test', wrap(async (req, res) => {
  const body = req.body ?? {};
  if (body.baseUrl && !isSafeBaseUrl(String(body.baseUrl))) {
    return res.status(400).json({ error: 'baseUrl tidak diizinkan — hanya http(s), tanpa credential/metadata internal' });
  }
  res.json(await testConnection(req.userId, body));
}));

// Periodic pruning of per-user AI rate-limit entries (5 min).
setInterval(() => {
  const now = Date.now();
  for (const [userId, kinds] of aiLimits) {
    for (const kind of Object.keys(kinds)) {
      if (now > kinds[kind].resetAt) delete kinds[kind];
    }
    if (Object.keys(kinds).length === 0) aiLimits.delete(userId);
  }
}, 5 * 60 * 1000).unref?.();

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve built frontend if present
app.use(express.static(join(__dirname, '../../frontend/dist')));

// --- Bootstrapping ---
seedAdminFromEnv();

// Preload state for users who already have persisted files (so background
// loops and requests work after restart without waiting for first request).
// Only UUID-named files are user state — users.json/sessions.json are not users.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
try {
  // Clean up orphaned temp files from previous crashed processes.
  cleanupTempFiles();
  if (existsSync(DATA_DIR)) {
    for (const f of readdirSync(DATA_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const userId = f.slice(0, -5);
      if (!UUID_RE.test(userId)) continue;
      initWallet(userId);
      initAutopilot(userId);
    }
  }
} catch {}

// --- Background loops (per user) ---
let limitTickRunning = false;
setInterval(async () => {
  if (limitTickRunning) return;
  limitTickRunning = true;
  try {
    for (const userId of listUsers()) {
      try {
        const allPos = getPositions(userId);
        if (allPos.length === 0) continue;
        const markets = await dexscreener.tokens(allPos.map((p) => p.tokenAddress)).catch(() => new Map());
        const priceMap = new Map();
        for (const p of allPos) {
          const norm = markets.get(p.tokenAddress.toLowerCase());
          if (norm?.priceUsd) priceMap.set(p.tokenAddress, norm.priceUsd);
        }
        updatePositionPrices(userId, priceMap);
        const filled = checkLimitOrders(userId, priceMap);
        if (filled.length > 0) console.log(`[limit-matcher] ${userId}: ${filled.length} order(s) filled`);
      } catch (e) {
        console.warn(`[limit-matcher] ${userId}: ${sanitizeError(e?.message ?? e)}`);
      }
    }
  } catch (e) {
    // silent — will retry next interval
  } finally {
    limitTickRunning = false;
  }
}, 5_000);

// One flag per user, not one for the process. A single global boolean meant that
// any user whose tick was slow suppressed the sweep for everybody — including
// their stop-loss, which is why the per-user set matters more than the deadline.
const autopilotTicksRunning = new Set();

// The sweep must never be held hostage by one provider. Inside a tick the
// scout can spend up to llmTimeoutMs per hedged provider (clamped at 180s), and
// the guardian's per-position calls stack on top of that; a serial sweep waits
// for all of it. So each user gets a bounded slice and the rest are served
// immediately. `ponytail:` the ceiling is generous because a premature cut-off
// still leaves the tick running to completion — it costs a late push, not an
// aborted exit. Lower it once tick latency is observable.
const AUTOPILOT_TICK_DEADLINE_MS = 30_000;

setInterval(async () => {
  for (const userId of listUsers()) {
    // The deadline abandons the WAIT, not the tick: runTickWithDeadline keeps
    // this user's slot claimed until the tick really finishes, so no two ever
    // overlap, while the sweep moves on.
    const res = await runTickWithDeadline(
      autopilotTicksRunning,
      userId,
      () => runAutopilotTick(userId),
      AUTOPILOT_TICK_DEADLINE_MS,
    );

    // Push on EVERY outcome, including the two that bail below. The radar was
    // reachable without the guardian: pushSignals dedupes per user and the scan
    // has its own cache, so a slow tick was costing one late refresh and nothing
    // else. Gating the push on a healthy tick coupled the radar's freshness to
    // LLM provider latency — a hanging provider froze the market table even
    // though nothing about the radar depended on the guardian. Node is
    // single-threaded, so a sync read here cannot interleave with the running
    // tick's writes; the worst case is one snapshot a beat stale, which the next
    // sweep corrects.
    pushForUser(userId);

    if (res === TICK_DEADLINE) {
      console.warn(`[autopilot] ${userId}: tick exceeded ${AUTOPILOT_TICK_DEADLINE_MS}ms — exits for this user are late this round`);
      continue;
    }
    // Normal for a user whose previous tick overran: it is still finishing. Not
    // worth a log line every 5s — and it pushes nothing of its own, which is why
    // the sweep above must.
    if (res === TICK_BUSY) continue;
    if (res?.executed) console.log(`[autopilot] ${userId}: ${res.log ?? 'Executed trade'}`);
  }
}, 5_000);

// Flush pending writes on shutdown.
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

// Last-resort JSON error handler. Without it an unhandled throw (a disk failure
// in the account store, a malformed state file) reaches Express's default
// finalhandler, which renders an HTML page WITH the stack trace whenever
// NODE_ENV !== 'production' — and this repo never sets NODE_ENV. The API is
// JSON, so a failed request must answer JSON and leak nothing.
// Must be registered after every route.
app.use((err, _req, res, _next) => {
  console.error('[error]', redact(err?.stack ?? err?.message ?? err));
  if (res.headersSent) return;
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
    ? err.status
    : (err?.code === 'UPSTREAM_ERROR' ? 502 : 500);
  res.status(status).json({ error: sanitizeError(err?.message ?? err) });
});

// Last-resort safety net: a stray rejection in a background loop (autopilot
// tick, LLM hedge, price refresh) must NOT take down every user's server.
// Node 15+ kills the process on an unhandled rejection, so we observe, redact,
// and keep serving. Genuine bugs are still logged loudly for triage.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] unhandled rejection (kept alive):', redact(reason instanceof Error ? (reason.stack ?? reason.message) : reason));
});
process.on('uncaughtException', (err) => {
  // A thrown synchronously outside async boundaries is harder to survive, but
  // logging here (rather than dying silently) at least captures the cause.
  console.error('[fatal-guard] uncaught exception:', redact(err?.stack ?? err?.message ?? err));
});

app.listen(PORT, () => {
  console.log(`Trading backend → http://localhost:${PORT}`);
});