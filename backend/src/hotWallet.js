// Backend Hot Wallet for Autopilot Trading (Server-Side Key Management)
// Per-user encrypted keystore (AES-256-GCM). Keys never leave server; autopilot
// uses this to sign + broadcast Jupiter swaps without user interaction via Phantom.
// Importers/callers: server.js (/api/real/hot-wallet/*), realIntent.js (auto-executor).
// User instruction: "Autopilot eksekusi nyata 24/7 tanpa klik Phantom tiap transaksi".

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Keypair, VersionedTransaction, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getBoundWallet } from './realIntent.js';

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

// USDC mint differs per network
const USDC_MINT_BY_NETWORK = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet:  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  testnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

export function getNetwork() {
  return (process.env.NETWORK || 'mainnet').toLowerCase();
}

export function getSolanaRpcUrl() {
  const net = getNetwork();
  // NETWORK is the source of truth for which chain the hot wallet trades on.
  // A per-network default is used unless BACKEND_SOLANA_RPC explicitly matches.
  const defaults = {
    mainnet: 'https://api.mainnet-beta.solana.com',
    devnet:  'https://api.devnet.solana.com',
    testnet: 'https://api.testnet.solana.com',
  };
  const explicit = process.env.BACKEND_SOLANA_RPC || process.env.VITE_SOLANA_RPC;
  if (explicit) {
    // If the user explicitly set a custom RPC, trust it — but only when it
    // points at the configured network. A stale mainnet RPC must not be used
    // to check a devnet wallet (that's what made the faucet claim "not appear").
    const matchesNetwork = explicit.includes('devnet') && net === 'devnet'
      || explicit.includes('testnet') && net === 'testnet'
      || (explicit.includes('mainnet-beta') || explicit.includes('mainnet')) && net === 'mainnet';
    return matchesNetwork ? explicit : defaults[net] ?? defaults.mainnet;
  }
  return defaults[net] ?? defaults.mainnet;
}

function getUsdcMint() {
  return USDC_MINT_BY_NETWORK[getNetwork()] ?? USDC_MINT_BY_NETWORK.mainnet;
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
  const conn = getSolanaConnection();
  if (intent.side === 'buy') {
    const lamports = Number(intent.amountSol);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      throw new Error('Intent buy tanpa amountSol yang valid');
    }
    // Fee reserve: a buy that spends the LAST lamports leaves nothing to pay
    // the exit swap's fee, so the position can never be sold (stuck bag). Hold
    // back a small reserve and refuse the buy if it would breach it.
    const bal = await conn.getBalance(kp.publicKey);
    if (bal < lamports + HOT_WALLET_FEE_RESERVE_LAMPORTS) {
      throw new Error(
        `Saldo SOL hot wallet tidak cukup untuk buy + cadangan fee: ${(bal / 1e9).toFixed(6)} SOL tersedia, ` +
        `butuh ${((lamports + HOT_WALLET_FEE_RESERVE_LAMPORTS) / 1e9).toFixed(6)} SOL`,
      );
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
    let atomic = Math.floor(Number(intent.estTokens) * Math.pow(10, Number(decimals)));
    if (!Number.isFinite(atomic) || atomic <= 0) {
      throw new Error('Jumlah sell token tidak valid');
    }
    // Clamp to what the wallet ACTUALLY holds on-chain. The virtual ledger is a
    // mirror: it can drift ahead of the real balance (a partially-filled buy, a
    // manual transfer out). Selling more than we hold makes Jupiter build a tx
    // that fails simulation, so clamp down instead of failing the whole exit.
    const held = await getOnChainTokenAmount(kp.publicKey, intent.tokenAddress);
    if (held === null) {
      throw new Error('Gagal membaca saldo token on-chain — sell dibatalkan (mencegah over-sell)');
    }
    if (held <= 0) {
      throw new Error('Hot wallet tidak memegang token ini on-chain — sell dibatalkan');
    }
    // Clamp atomically with BigInt, but hand Jupiter a plain number (atomic units
    // are human-quantities × 10^decimals; a 6-decimal token at 1M tokens is
    // 1e12 atomic, far under MAX_SAFE_INTEGER 9.2e18). BigInt here only guards
    // the comparison, not the delivered value.
    if (BigInt(atomic) > held) {
      atomic = Number(held);
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

  try {
    // 3. Sign transaction locally
    const txBytes = Buffer.from(swap.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(Uint8Array.from(txBytes));
    tx.sign([kp]);

    // 4. Simulate before broadcast to catch failure without burning fees
    const sim = await conn.simulateTransaction(tx);
    if (sim.value?.err) {
      throw new Error(`Simulasi on-chain gagal: ${JSON.stringify(sim.value.err).slice(0, 160)}`);
    }

    // 5. Broadcast to network
    const serialized = tx.serialize();
    const sig = await conn.sendRawTransaction(serialized, { maxRetries: 2 });
    await conn.confirmTransaction(sig, 'confirmed');

    return {
      ok: true,
      signature: sig,
      userPublicKey,
      inputMint,
      outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
    };
  } finally {
    // The decrypted keypair must not linger in the heap after the tx is built.
    try { kp.secretKey.fill(0); } catch {}
  }
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
  // Refuse to silently clobber an existing keystore. Overwriting orphans the
  // old address's funds permanently (a generated key can never be exported),
  // so callers must delete explicitly if they truly mean to replace it.
  const existing = map.get(userId);
  if (existing?.publicKey && existing.publicKey !== record.publicKey) {
    throw new Error(
      `Hot wallet sudah ada untuk user ini (${existing.publicKey}). ` +
      'Hapus dulu sebelum membuat/mengimpor yang baru — menimpa akan membuat dana di alamat lama tidak bisa diakses.',
    );
  }
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

  let decrypted = null;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Keypair.fromSecretKey copies the bytes it needs, so zeroing the plaintext
    // buffer right after is safe and keeps key material out of the heap.
    return Keypair.fromSecretKey(Uint8Array.from(decrypted));
  } catch (e) {
    throw new Error('Gagal mendekripsi hot-wallet: MASTER_ENCRYPTION_KEY tidak cocok atau data corrupt');
  } finally {
    try { decrypted?.fill(0); } catch {}
    try { derivedKey.fill(0); } catch {}
  }
}

/** Get public status only (no secrets). */
export function getHotWalletPublicInfo(userId) {
  const map = loadKeystores();
  const record = map.get(userId);
  const network = getNetwork();
  if (!record) return { exists: false, publicKey: null, network };
  return {
    exists: true,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    network,
  };
}

/** Read-only SOL balance of the user's hot wallet (for funding UX). */
export async function getHotWalletBalance(userId) {
  const info = getHotWalletPublicInfo(userId);
  if (!info.exists) return { exists: false, publicKey: null, balanceSol: 0 };
  const lamports = await getSolanaConnection().getBalance(new PublicKey(info.publicKey));
  return { exists: true, publicKey: info.publicKey, balanceSol: lamports / 1e9 };
}

// SOL that must stay UNSPENT in the hot wallet so exits (SL/TP/trailing) can
// still pay for a swap tx fee. Without a reserve, a "full" hot wallet can trade
// itself into a state where it holds only tokens + zero SOL → every exit fails
// and the position becomes a stuck bag.
export const HOT_WALLET_FEE_RESERVE_LAMPORTS = 200_000; // 0.0002 SOL — ~5 swaps-worth of fee

/**
 * Read the wallet's on-chain balance of an SPL token, in atomic units. Returns
 * null if the wallet has no account for the mint, or on RPC failure (caller
 * decides whether that is "hold nothing" or "cannot know" — both refuse to sell).
 */
async function getOnChainTokenAmount(ownerPubkey, mint) {
  try {
    const accounts = await getSolanaConnection().getParsedTokenAccountsByOwner(ownerPubkey, { mint: new PublicKey(mint) });
    const a = accounts.value[0];
    if (!a) return null;
    const amt = Number(a.account.data.parsed.info.tokenAmount.amount);
    return Number.isFinite(amt) ? BigInt(Math.max(0, Math.floor(amt))) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the hot wallet can afford a BUY of `usdAmount` (converted to SOL) and
 * still keep the fee reserve. This is the REAL-money affordability check the
 * virtual-balance-based sizing never sees: `usdAmount` may pass the per-trade
 * cap yet be far beyond the wallet's actual SOL.
 *
 * Returns { ok, balanceSol, solNeeded, buyUsd, reserveSol, reason }.
 */
export async function checkHotWalletAffordability(userId, usdAmount, { solUsd } = {}) {
  const bal = await getHotWalletBalance(userId);
  if (!bal.exists) {
    return { ok: false, balanceSol: 0, solNeeded: 0, buyUsd: 0, reserveSol: 0, reason: 'NO_WALLET' };
  }
  const solUsdNum = Number(solUsd);
  if (!Number.isFinite(solUsdNum) || solUsdNum <= 0) {
    return { ok: false, balanceSol: bal.balanceSol, solNeeded: 0, buyUsd: 0, reserveSol: 0, reason: 'NO_SOL_PRICE' };
  }
  const reserveSol = HOT_WALLET_FEE_RESERVE_LAMPORTS / 1e9;
  const spendableSol = Math.max(0, bal.balanceSol - reserveSol);
  const spendableUsd = spendableSol * solUsdNum;
  const coinUsd = Number(usdAmount);
  const usdWanted = Number.isFinite(coinUsd) && coinUsd > 0 ? coinUsd : 0;
  if (usdWanted <= 0) {
    return { ok: false, balanceSol: bal.balanceSol, solNeeded: 0, buyUsd: 0, reserveSol, reason: 'BAD_AMOUNT' };
  }
  if (spendableUsd <= 0) {
    return { ok: false, balanceSol: bal.balanceSol, solNeeded: usdWanted / solUsdNum, buyUsd: 0, reserveSol, reason: 'NO_SPENDABLE' };
  }
  if (usdWanted > spendableUsd) {
    return { ok: false, balanceSol: bal.balanceSol, solNeeded: usdWanted / solUsdNum, buyUsd: spendableUsd, reserveSol, reason: 'LOW_BALANCE' };
  }
  return { ok: true, balanceSol: bal.balanceSol, solNeeded: usdWanted / solUsdNum, buyUsd: usdWanted, reserveSol, reason: 'OK' };
}

/**
 * Sign a base64 Jupiter swapTransaction with the user's decrypted hot-wallet key.
 * Returns the signed serialized transaction bytes.
 * NOTE: the caller must zero the returned bytes after use — they are the signed
 * tx, not the key, so this is only a hygiene measure, not a secret.
 */
export function signVersionedTransaction(userId, swapTxBase64, masterKey = getMasterKey()) {
  const kp = decryptHotWalletKeypair(userId, masterKey);
  try {
    const txBytes = Buffer.from(swapTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(Uint8Array.from(txBytes));
    tx.sign([kp]);
    return tx.serialize();
  } finally {
    // Do not leave the private key material in the heap longer than needed.
    try { kp.secretKey.fill(0); } catch {}
  }
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

/**
 * Withdraw SOL from the user's hot wallet to their bound Phantom wallet.
 * Only allowed to the wallet that is bound for this user (anti-hijack).
 * Returns { ok: true, signature, lamports, to } on success.
 */
export async function withdrawFromHotWallet(userId, lamports, { masterKey = getMasterKey() } = {}) {
  if (isEmergencyPaused()) {
    throw new Error('Circuit Breaker: Emergency Pause aktif. Semua transaksi hot-wallet dihentikan.');
  }

  // Only ever send to the wallet this user BOUND. Even if the server is
  // compromised, funds cannot be redirected to an attacker's address.
  const bound = getBoundWallet(userId);
  if (!bound) throw new Error('Wallet belum di-bind. Bind wallet di panel Real Wallet dulu.');
  let toPubkey;
  try { toPubkey = new PublicKey(bound); } catch { throw new Error('Alamat wallet yang di-bind tidak valid'); }

  const amount = Math.floor(Number(lamports));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Jumlah withdraw harus > 0');

  const kp = decryptHotWalletKeypair(userId, masterKey);
  try {
    const conn = getSolanaConnection();
    const fromPubkey = kp.publicKey;

    const balance = await conn.getBalance(fromPubkey);
    // Leave a small buffer for the transfer fee itself.
    const FEE_BUFFER_LAMPORTS = 5_000;
    if (balance < amount + FEE_BUFFER_LAMPORTS) {
      throw new Error(
        `Saldo tidak cukup: ${(balance / 1e9).toFixed(6)} SOL, butuh ${((amount + FEE_BUFFER_LAMPORTS) / 1e9).toFixed(6)} SOL (termasuk fee)`,
      );
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey, toPubkey, lamports: amount }),
    );
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromPubkey;
    tx.sign(kp);

    // Simulate before broadcasting so a bad tx costs no fee.
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`Simulasi gagal: ${JSON.stringify(sim.value.err)}`);

    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
    await conn.confirmTransaction(sig, 'confirmed');

    return { ok: true, signature: sig, lamports: amount, to: bound, network: getNetwork() };
  } finally {
    // Never leave the private key material in the heap.
    try { kp.secretKey.fill(0); } catch {}
  }
}

// Emergency Global Pause
let emergencyPaused = false;
export function setEmergencyPaused(paused) {
  emergencyPaused = Boolean(paused);
}
export function isEmergencyPaused() {
  return emergencyPaused;
}
