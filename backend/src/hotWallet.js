// Backend Hot Wallet for Autopilot Trading (Server-Side Key Management)
// Per-user encrypted keystore (AES-256-GCM). Keys never leave server; autopilot
// uses this to sign + broadcast Jupiter swaps without user interaction via Phantom.
// Importers/callers: server.js (/api/real/hot-wallet/*), realIntent.js (auto-executor).
// User instruction: "Autopilot eksekusi nyata 24/7 tanpa klik Phantom tiap transaksi".

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Keypair, VersionedTransaction, Connection } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
// Resolved LAZILY (not at module load) so tests can point HOT_WALLET_KEYS_FILE
// at a temp dir — ESM hoists imports, so a top-level `process.env` assignment in
// a test file runs *after* this module is evaluated and would be missed.
function keysFile() {
  return process.env.HOT_WALLET_KEYS_FILE || join(DATA_DIR, 'hotwallets.json');
}
const ENCRYPTION_KEY_SIZE_BYTES = 32; // AES-256
const NONCE_SIZE_BYTES = 12;          // GCM 96-bit nonce
const DEFAULT_MAX_USD_PER_TRADE = 50; // hard ceiling per automated swap
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

function getSolanaRpcUrl() {
  return process.env.BACKEND_SOLANA_RPC || process.env.VITE_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
}

export function getSolanaConnection() {
  return new Connection(getSolanaRpcUrl(), 'confirmed');
}

// Token decimals cache — Jupiter's public token API. Sell sizing needs it to
// convert human token units into atomic units; guessing 9 for a 6-decimal token
// would over-sell by 1000x. Cached 1h.
const decimalsCache = new Map(); // mint -> { at, decimals }
export async function resolveTokenDecimals(mint) {
  const hit = decimalsCache.get(mint);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.decimals;
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const found = (Array.isArray(data) ? data : []).find((t) => t.address === mint) ?? null;
    if (found && Number.isFinite(Number(found.decimals))) {
      const decimals = Number(found.decimals);
      decimalsCache.set(mint, { at: Date.now(), decimals });
      return decimals;
    }
  } catch {
    // fall through — caller decides whether a default is safe
  }
  return null;
}

/** Fetch from Jupiter Swap API with timeout (GET for /quote, POST for /swap). */
async function jupiterFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${JUPITER_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jupiter ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Execute a real intent directly on-chain using the user's decrypted hot wallet.
 * Steps: Emergency check -> Rate limit check -> Trade size check -> Quote -> Swap -> Sign -> Broadcast -> Mark Done.
 */
export async function executeIntentWithHotWallet(userId, intent, { masterKey = getMasterKey(), getTokenDecimalsFn = null } = {}) {
  if (isEmergencyPaused()) {
    throw new Error('Circuit Breaker: Emergency Pause aktif. Semua transaksi hot-wallet dihentikan.');
  }

  if (!checkHotWalletRateLimit(userId)) {
    throw new Error('Rate limit hot-wallet tercapai (maks 5 transaksi per menit)');
  }

  const sizeCheck = checkTradeSize(intent.amountUsd);
  if (!sizeCheck.ok) {
    throw new Error(sizeCheck.reason);
  }

  const kp = decryptHotWalletKeypair(userId, masterKey);
  const userPublicKey = kp.publicKey.toBase58();

  // Resolve input/output mints and atomic amount
  let inputMint, outputMint, amount;
  if (intent.side === 'buy') {
    const lamports = Number(intent.amountSol);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      throw new Error('Intent buy tanpa amountSol yang valid');
    }
    inputMint = SOL_MINT;
    outputMint = intent.tokenAddress;
    amount = Math.floor(lamports);
  } else {
    const resolver = typeof getTokenDecimalsFn === 'function' ? getTokenDecimalsFn : resolveTokenDecimals;
    const decimals = await resolver(intent.tokenAddress);
    // NEVER guess decimals on a sell: 9 for a 6-decimal token over-sells 1000x.
    if (decimals === null || !Number.isFinite(Number(decimals))) {
      throw new Error('Gagal resolve desimal token — sell dibatalkan (mencegah salah unit)');
    }
    const atomic = Math.floor(Number(intent.estTokens) * Math.pow(10, Number(decimals)));
    if (!Number.isFinite(atomic) || atomic <= 0) {
      throw new Error('Jumlah sell token tidak valid');
    }
    inputMint = intent.tokenAddress;
    outputMint = SOL_MINT;
    amount = atomic;
  }

  // 1. Get quote (GET request with query params)
  const quote = await jupiterFetch(`/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amount}&slippageBps=100`, {});

  // 2. Build swap transaction for user's hot wallet public key (POST)
  const swap = await jupiterFetch('/swap', {
    method: 'POST',
    body: {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    },
  });
  if (!swap.swapTransaction) throw new Error('Jupiter tidak mengembalikan swapTransaction');

  // 3. Sign transaction locally
  const txBytes = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(Uint8Array.from(txBytes));
  tx.sign([kp]);

  // 4. Simulate before broadcast to catch failure without burning fees
  const connection = getSolanaConnection();
  const sim = await connection.simulateTransaction(tx);
  if (sim.value?.err) {
    throw new Error(`Simulasi on-chain gagal: ${JSON.stringify(sim.value.err).slice(0, 160)}`);
  }

  // 5. Broadcast to network
  const serialized = tx.serialize();
  const sig = await connection.sendRawTransaction(serialized, { maxRetries: 2 });
  await connection.confirmTransaction(sig, 'confirmed');

  return {
    ok: true,
    signature: sig,
    userPublicKey,
    inputMint,
    outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
  };
}

function ensureDataDir() {
  // Create the directory of whatever keystore path is in effect (tests point
  // HOT_WALLET_KEYS_FILE at a temp dir).
  mkdirSync(dirname(keysFile()), { recursive: true });
}

/** Get the server master encryption key from env. Throws if not configured. */
export function getMasterKey() {
  const k = process.env.MASTER_ENCRYPTION_KEY;
  if (!k || String(k).trim().length < 16) {
    throw new Error('MASTER_ENCRYPTION_KEY belum diset di .env (minimal 16 karakter)');
  }
  return String(k).trim();
}

/**
 * Derive a per-user 32-byte AES key from MASTER_ENCRYPTION_KEY via scrypt.
 * Salt is scoped by userId so User A's key cannot decrypt User B's keystore
 * even if they share the same master secret.
 */
function deriveKey(userId, masterKey) {
  if (!userId || typeof userId !== 'string') throw new Error('userId required');
  return scryptSync(masterKey, `hotwallet:${userId}`, ENCRYPTION_KEY_SIZE_BYTES);
}

/** Load all hot-wallet records from disk (userId -> record). */
export function loadKeystores() {
  ensureDataDir();
  try {
    if (!existsSync(keysFile())) return new Map();
    const raw = JSON.parse(readFileSync(keysFile(), 'utf-8'));
    const list = Array.isArray(raw?.keystores) ? raw.keystores : [];
    const map = new Map();
    for (const e of list) {
      if (e?.userId && e.publicKey && e.ciphertext && e.iv && e.tag) {
        map.set(e.userId, {
          userId: e.userId,
          publicKey: String(e.publicKey),
          ciphertext: String(e.ciphertext),
          iv: String(e.iv),
          tag: String(e.tag),
          createdAt: Number(e.createdAt) || Date.now(),
          updatedAt: Number(e.updatedAt) || Date.now(),
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Save keystores atomically (matches persistence.js write-rename pattern). */
function saveKeystores(map) {
  ensureDataDir();
  const target = keysFile();
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const payload = JSON.stringify({ keystores: Array.from(map.values()) }, null, 2);
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * Generate a fresh Solana keypair for userId, encrypt private key (AES-256-GCM),
 * and save to keystore.
 * Returns public metadata only (publicKey). Secret key never leaves server.
 */
export function generateHotWallet(userId, masterKey = getMasterKey()) {
  const kp = Keypair.generate();
  return saveEncryptedKeypair(userId, kp, masterKey);
}

/**
 * Import an existing 64-byte secretKey (Uint8Array or array of numbers),
 * encrypt, and save to keystore for userId.
 */
export function importHotWallet(userId, secretKeyBytes, masterKey = getMasterKey()) {
  const u8 = secretKeyBytes instanceof Uint8Array ? secretKeyBytes : Uint8Array.from(secretKeyBytes);
  if (u8.length !== 64) throw new Error('Secret key harus 64 byte (Uint8Array Ed25519 keypair)');
  const kp = Keypair.fromSecretKey(u8);
  return saveEncryptedKeypair(userId, kp, masterKey);
}

function saveEncryptedKeypair(userId, kp, masterKey) {
  const derivedKey = deriveKey(userId, masterKey);
  const iv = randomBytes(NONCE_SIZE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);

  const secretBuffer = Buffer.from(kp.secretKey);
  const encrypted = Buffer.concat([cipher.update(secretBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  const map = loadKeystores();
  const now = Date.now();
  const record = {
    userId,
    publicKey: kp.publicKey.toBase58(),
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    createdAt: map.get(userId)?.createdAt ?? now,
    updatedAt: now,
  };
  map.set(userId, record);
  saveKeystores(map);

  return {
    publicKey: record.publicKey,
    createdAt: record.createdAt,
  };
}

/** Decrypt and return the Solana Keypair instance for userId. */
export function decryptHotWalletKeypair(userId, masterKey = getMasterKey()) {
  const map = loadKeystores();
  const record = map.get(userId);
  if (!record) throw new Error(`Hot wallet untuk user ${userId} belum dibuat`);

  const derivedKey = deriveKey(userId, masterKey);
  const iv = Buffer.from(record.iv, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const ciphertext = Buffer.from(record.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return Keypair.fromSecretKey(Uint8Array.from(decrypted));
  } catch (e) {
    throw new Error('Gagal mendekripsi hot-wallet: MASTER_ENCRYPTION_KEY tidak cocok atau data corrupt');
  }
}

/** Get public status only (no secrets). */
export function getHotWalletPublicInfo(userId) {
  const map = loadKeystores();
  const record = map.get(userId);
  if (!record) return { exists: false, publicKey: null };
  return {
    exists: true,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Sign a base64 Jupiter swapTransaction with the user's decrypted hot-wallet key.
 * Returns the signed serialized transaction bytes.
 */
export function signVersionedTransaction(userId, swapTxBase64, masterKey = getMasterKey()) {
  const kp = decryptHotWalletKeypair(userId, masterKey);
  const txBytes = Buffer.from(swapTxBase64, 'base64');
  const tx = VersionedTransaction.deserialize(Uint8Array.from(txBytes));
  tx.sign([kp]);
  return tx.serialize();
}

// --- Circuit Breaker & Safety Guards ---

const rateLimitState = new Map(); // userId -> { count, resetAt }
const RATE_WINDOW_MS = 60_000;
const MAX_TRADES_PER_MIN = 5;

/** Throttles hot-wallet auto executions (max 5 per minute per user). */
export function checkHotWalletRateLimit(userId) {
  const now = Date.now();
  let entry = rateLimitState.get(userId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitState.set(userId, entry);
  }
  if (entry.count >= MAX_TRADES_PER_MIN) return false;
  entry.count++;
  return true;
}

/** Validates trade size against hard USD ceiling. */
export function checkTradeSize(usdAmount) {
  const cap = Number(process.env.HOT_WALLET_MAX_USD_PER_TRADE) || DEFAULT_MAX_USD_PER_TRADE;
  const val = Number(usdAmount);
  if (!Number.isFinite(val) || val <= 0) return { ok: false, reason: 'usdAmount tidak valid' };
  if (val > cap) return { ok: false, reason: `Melebihi batas maksimal $${cap} USD per transaksi hot-wallet` };
  return { ok: true, cap };
}

// Emergency Global Pause
let emergencyPaused = false;
export function setEmergencyPaused(paused) {
  emergencyPaused = Boolean(paused);
}
export function isEmergencyPaused() {
  return emergencyPaused;
}
