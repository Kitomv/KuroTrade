// Trading dashboard backend — Express 5 ESM
// Proxies DexScreener REST, caches 15s, owns watchlist + price history.
// Multi-user: Bearer-token auth, per-user persisted state.

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';
import { dexscreener } from './dexscreener.js';
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
import {
  isRealMode, setRealMode, isRealAuto, setRealAuto,
  getRealIntents, getRealIntent, setRealIntentStatus, addRealIntent,
  getBoundWallet, bindWallet, assertBoundWallet, buildBindMessage, createBindChallenge,
} from './realIntent.js';
import { verifyUser, createSession, getUser, destroySession, seedAdminFromEnv,
  changePassword, destroyOtherSessions, listUsers as listAuthUsers, getUserById, adminSetPassword, deleteUser } from './auth.js';
import { flushAll, cleanupTempFiles } from './persistence.js';
import { securityHeaders, redact, sanitizeError, ipRateLimit, isSafeBaseUrl } from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Security headers before body parsing/CORS, so malformed or oversized requests
// still receive defensive response headers.
app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));

// CORS — restrict to local dev origins.
const DEV_ORIGINS = [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = DEV_ORIGINS.some((r) => r.test(origin));
    if (allowed) res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Auth middleware: resolves req.userId from Bearer token ---
// Guards ONLY /api/* data routes. Static frontend (/, /assets/*) stays public —
// the SPA gate handles auth client-side; blocking assets would blank the app.
const PUBLIC_PATHS = new Set(['/api/login', '/api/health']);
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || !req.path.startsWith('/api/') || PUBLIC_PATHS.has(req.path)) return next();
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const userId = getUser(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  req.token = token;
  req.role = getUserById(userId)?.role ?? 'user';
  next();
});

const requireAdmin = (req, res, next) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

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
app.use('/api/real', ipRateLimit({ max: 60, windowMs: 60_000 }));   // quotes/swap/bind/intents
app.use('/api/llm', ipRateLimit({ max: 30, windowMs: 60_000 }));    // config saves + provider probes

// Simple per-IP brute-force guard: max 10 failed logins per 5 minutes.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { loginAttempts.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function noteLoginFailure(ip) {
  const rec = loginAttempts.get(ip);
  if (rec && Date.now() <= rec.resetAt) { rec.count++; return; }
  loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
}

// Periodic map pruning (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) if (now > rec.resetAt) loginAttempts.delete(ip);
}, 5 * 60 * 1000).unref?.();

app.post('/api/login', loginLimiter, (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = verifyUser(String(username), String(password));
  if (!user) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  loginAttempts.delete(ip);
  const token = createSession(user.id);
  res.json({ token, userId: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) destroySession(auth.slice(7));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUserById(req.userId);
  res.json({ userId: req.userId, username: user?.username ?? '', role: user?.role ?? 'user', wallet: getWallet(req.userId) });
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

// --- Admin: user management ---
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = listAuthUsers().map((u) => ({ ...u, wallet: getWallet(u.id) }));
  res.json(users);
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body ?? {};
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'Password baru minimal 8 karakter' });
  if (!getUserById(req.params.id)) return res.status(404).json({ error: 'User tidak ditemukan' });
  try {
    adminSetPassword(req.params.id, String(newPassword));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
  const users = listAuthUsers();
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (target.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir' });
  }
  try {
    deleteUser(req.params.id);
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
      role: u.role,
      totalValue: w.totalValue,
      pnlPct: Math.round(((w.totalValue - w.initialBalance) / w.initialBalance) * 10000) / 100,
      positionsCount: getPositions(u.id).length,
    };
  }).sort((a, b) => b.totalValue - a.totalValue);
  res.json(rows);
});

// --- Real trading: Jupiter proxy (stateless, no private keys touch the server) ---
const JUPITER_BASE = process.env.JUPITER_API_BASE || 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function jupiterFetch(path, body) {
  const res = await fetch(`${JUPITER_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jupiter ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

app.post('/api/real/quote', rateLimit('quote', 20), wrap(async (req, res) => {
  const { inputMint, outputMint, amount, slippageBps } = req.body ?? {};
  if (!BASE58_RE.test(String(inputMint)) || !BASE58_RE.test(String(outputMint))) {
    return res.status(400).json({ error: 'inputMint/outputMint harus alamat mint base58 valid' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount harus > 0 (satuan terkecil, mis. lamports)' });
  const slip = Math.min(500, Math.max(1, Number(slippageBps) || 100)); // cap 5%
  const q = await jupiterFetch(`/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${Math.floor(amt)}&slippageBps=${slip}`, undefined);
  res.json({
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    priceImpactPct: q.priceImpactPct,
    routeLabels: (q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean),
    slippageBps: slip,
    rawQuote: q, // needed verbatim by /api/real/swap-tx
  });
}));

// Token decimals cache for SELL atomic-unit conversion (audit C1 companion).
// DexScreener normalize() lacks decimals; Jupiter's public token search API has it.
const decimalsCache = new Map(); // mint -> { at, decimals }
async function getTokenDecimals(mint) {
  const hit = decimalsCache.get(mint);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.decimals;
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`token api ${res.status}`);
    const data = await res.json();
    const found = (Array.isArray(data) ? data : []).find((t) => t.address === mint) ?? (Array.isArray(data) ? data[0] : null);
    if (found && Number.isFinite(Number(found.decimals))) {
      decimalsCache.set(mint, { at: Date.now(), decimals: Number(found.decimals) });
      return Number(found.decimals);
    }
  } catch (e) {
    console.warn(`[real] decimals lookup failed for ${mint}: ${e.message}`);
  }
  return null; // caller must refuse to guess
}

app.post('/api/real/swap-tx', rateLimit('quote', 20), wrap(async (req, res) => {
  // Intent-bound swap (audit M3): with `intentId` the server rebuilds the quote
  // from the stored intent (side, mints, amounts, slippage ≤ 1%) — the client
  // cannot control what gets signed. Without it, manual flow still requires a
  // bound wallet (L1) but trusts the client's quoteResponse.
  const { quoteResponse, userPublicKey, intentId } = req.body ?? {};
  if (!BASE58_RE.test(String(userPublicKey))) return res.status(400).json({ error: 'userPublicKey tidak valid' });
  try { assertBoundWallet(req.userId, userPublicKey); } catch (e) { return res.status(403).json({ error: e.message }); }

  if (intentId) {
    const intent = getRealIntent(req.userId, intentId);
    if (!intent) return res.status(404).json({ error: 'Intent tidak ditemukan' });
    if (intent.status !== 'active') return res.status(409).json({ error: 'Intent tidak aktif / sudah diklaim sesi lain' });

    let inputMint, outputMint, amount;
    if (intent.side === 'buy') {
      const lamports = Number(intent.amountSol);
      // C1: never fall back to treating a USDC budget as SOL.
      if (!Number.isFinite(lamports) || lamports <= 0) {
        return res.status(400).json({ error: 'Intent buy tanpa amountSol — buat ulang intent (unit lama tidak aman)' });
      }
      inputMint = SOL_MINT; outputMint = intent.tokenAddress; amount = Math.floor(lamports);
    } else {
      const decimals = await getTokenDecimals(intent.tokenAddress);
      if (decimals === null) return res.status(400).json({ error: 'Gagal resolve desimal token — sell ditolak (mencegah salah unit)' });
      const atomic = Math.floor(Number(intent.estTokens) * Math.pow(10, decimals));
      if (!Number.isFinite(atomic) || atomic <= 0) return res.status(400).json({ error: 'Jumlah sell tidak valid' });
      inputMint = intent.tokenAddress; outputMint = SOL_MINT; amount = atomic;
    }

    const q = await jupiterFetch(`/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amount}&slippageBps=100`, undefined);
    const swap = await jupiterFetch('/swap', { quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true });
    if (!swap.swapTransaction) throw new Error('Jupiter tidak mengembalikan swapTransaction');
    return res.json({ swapTransaction: swap.swapTransaction, intentId });
  }

  if (!quoteResponse || typeof quoteResponse !== 'object') return res.status(400).json({ error: 'quoteResponse required' });
  // Client-supplied quote hardening: only accept a well-formed Jupiter quote
  // whose slippage is capped and whose mints are valid Solana addresses. This
  // does not replace the intent path (which rebuilds server-side) — it stops
  // malformed/hostile payloads from reaching the signer.
  const qInput = String(quoteResponse.inputMint ?? '');
  const qOutput = String(quoteResponse.outputMint ?? '');
  const qAmount = Number(quoteResponse.inAmount);
  // slippageBps is a REQUEST param to /quote, not in the raw Jupiter response.
  // Accept a reasonable range for the slippage that was used to get this quote.
  // The frontend should pass the slippage it requested via a separate field.
  const qSlippage = Number(quoteResponse.slippageBps);
  // If the quote doesn't carry slippage, fall back to a safe default (1%).
  // The actual swap will enforce whatever slippage Jupiter applied when the
  // quote was generated; this check just rejects absurd values.
  const effectiveSlippage = Number.isFinite(qSlippage) ? qSlippage : 100;
  if (!BASE58_RE.test(qInput) || !BASE58_RE.test(qOutput)) {
    return res.status(400).json({ error: 'quoteResponse.inputMint/outputMint tidak valid' });
  }
  if (qInput === qOutput) return res.status(400).json({ error: 'quoteResponse mints tidak boleh sama' });
  if (!Number.isFinite(qAmount) || qAmount <= 0) return res.status(400).json({ error: 'quoteResponse.inAmount tidak valid' });
  if (effectiveSlippage < 1 || effectiveSlippage > 500) {
    return res.status(400).json({ error: 'quoteResponse.slippageBps harus 1-500 (maks 5%)' });
  }
  const swap = await jupiterFetch('/swap', { quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true });
  if (!swap.swapTransaction) throw new Error('Jupiter tidak mengembalikan swapTransaction');
  res.json({ swapTransaction: swap.swapTransaction });
}));

// Wallet binding (L1): the server issues a single-use nonce challenge so a
// captured signature cannot be replayed. The client signs the exact message
// in Phantom; bindWallet consumes the nonce exactly once.
app.get('/api/real/bind-message', rateLimit('bind', 10), (req, res) => {
  const publicKey = String(req.query.publicKey ?? '');
  if (!BASE58_RE.test(publicKey)) return res.status(400).json({ error: 'publicKey base58 tidak valid' });
  res.json(createBindChallenge(req.userId, publicKey));
});

app.post('/api/real/bind', rateLimit('bind', 10), async (req, res) => {
  const { publicKey, signature } = req.body ?? {};
  if (!publicKey || !signature) return res.status(400).json({ error: 'publicKey & signature required' });
  if (!BASE58_RE.test(String(publicKey))) return res.status(400).json({ error: 'publicKey base58 tidak valid' });
  try {
    res.json(bindWallet(req.userId, String(publicKey), String(signature)));
  } catch (e) {
    // Signature/key validation is a client input error, not a proxy failure.
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

// --- Real-wallet pending intents (autopilot → user approves via Phantom) ---
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

// Auto-approve only removes the in-page click; Phantom still signs each tx.
// Default false, persisted per user, forcibly disabled when real mode is off.
app.get('/api/real/auto', async (req, res) => {
  const { isRealAuto } = await import('./realIntent.js');
  res.json({ realAuto: isRealAuto(req.userId) });
});

app.post('/api/real/auto', async (req, res) => {
  const { setRealAuto } = await import('./realIntent.js');
  const { realAuto } = req.body ?? {};
  res.json(setRealAuto(req.userId, Boolean(realAuto)));
});

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
      chainId: chainId ?? current?.chainId ?? 'solana',
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
      chainId: chainId ?? 'solana',
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

app.get('/api/agents/signals', rateLimit('signals', 10), wrap(async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  const signals = await scanMarketSignals(req.userId, limit);
  res.json(signals);
}));

app.get('/api/agents/autopilot', (req, res) => res.json(getAutopilot(req.userId)));
app.post('/api/agents/autopilot', (req, res) => {
  res.json(setAutopilot(req.userId, req.body ?? {}));
});
app.post('/api/agents/autopilot/clear-logs', (req, res) => {
  res.json(clearAutopilotLogs(req.userId));
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
  const usersDir = join(__dirname, '../data');
  if (existsSync(usersDir)) {
    for (const f of readdirSync(usersDir)) {
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
      } catch {}
    }
  } catch (e) {
    // silent — will retry next interval
  } finally {
    limitTickRunning = false;
  }
}, 5_000);

let autopilotTickRunning = false;
setInterval(async () => {
  if (autopilotTickRunning) return;
  autopilotTickRunning = true;
  try {
    for (const userId of listUsers()) {
      try {
        const res = await runAutopilotTick(userId);
        if (res?.executed) console.log(`[autopilot] ${userId}: ${res.log ?? 'Executed trade'}`);
      } catch (e) {
        // silent
      }
    }
  } finally {
    autopilotTickRunning = false;
  }
}, 5_000);

// Flush pending writes on shutdown.
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

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