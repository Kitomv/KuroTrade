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
import { dexscreener, getSolUsdPrice } from './dexscreener.js';

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
// SPL Token and SPL Token-2022. Jupiter routes across BOTH programs, so a
// portfolio that only reads the legacy program silently hides every Token-2022
// holding (a large share of new pump.fun / DeFi launches).
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];

/** All token accounts owned by `owner` across legacy + Token-2022 programs. */
async function getAllTokenAccounts(conn, owner) {
  const out = [];
  for (const programId of TOKEN_PROGRAMS) {
    const res = await conn
      .getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) })
      .catch(() => null);
    out.push(...(res?.value ?? []));
  }
  return out;
}

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

  // 1st source: Jupiter token search API (fast, cached).
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = await res.json();
      const found = (Array.isArray(data) ? data : []).find((t) => t.address === mint) ?? null;
      if (found && Number.isFinite(Number(found.decimals))) {
        const decimals = Number(found.decimals);
        decimalsCache.set(mint, { at: Date.now(), decimals });
        return decimals;
      }
    }
  } catch {
    // fall through to RPC
  }

  // 2nd source: on-chain mint account. This is the AUTHORITATIVE value — the
  // mint's own account data defines its decimals. Jupiter misses many
  // pump.fun memecoins (e.g. PUMPCAT), so an RPC fallback is required or sells
  // of those tokens fail as "desimal tidak terverifikasi".
  try {
    const info = await getSolanaConnection().getParsedAccountInfo(new PublicKey(mint));
    const decimals = Number(info?.value?.data?.parsed?.info?.decimals);
    if (Number.isFinite(decimals)) {
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

  // USD cap applies ONLY to BUY — SELL must be allowed to exit at any size
  // to prevent stuck positions. Cap is a BUY-side risk limit only.
  if (intent.side === 'buy') {
    const sizeCheck = checkTradeSize(intent.amountUsd);
    if (!sizeCheck.ok) throw new Error(sizeCheck.reason);
  }

  const kp = decryptHotWalletKeypair(userId, masterKey);
  // Every exit path must zero the decrypted keypair — including the balance /
  // decimals / on-chain reads below, which throw before the swap loop starts.
  try {
    const userPublicKey = kp.publicKey.toBase58();

    // Resolve input/output mints and atomic amount
    let inputMint, outputMint, amount;
    // Decimals of the RECEIVING side. A buy's `outputMint` is the token being
    // acquired, so the SOL that lands in it is what the cost basis must be
    // measured against — this is the value that makes PnL and win-rate honest.
    let outputDecimals = 9;
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
      // Best-effort: a wrong guess only skews the cost basis, it never moves
      // funds, so a resolver failure must not block the buy.
      const outDecimals = await resolveTokenDecimals(intent.tokenAddress).catch(() => null);
      if (Number.isFinite(Number(outDecimals))) outputDecimals = Number(outDecimals);
    } else {
      const resolver = typeof getTokenDecimalsFn === 'function' ? getTokenDecimalsFn : resolveTokenDecimals;
      const decimals = await resolver(intent.tokenAddress);
      // NEVER guess decimals on a sell: 9 for a 6-decimal token over-sells 1000x.
      if (decimals === null || !Number.isFinite(Number(decimals))) {
        throw new Error('Gagal resolve desimal token — sell dibatalkan (mencegah salah unit)');
      }
      outputDecimals = 9; // receiving side of a sell is wrapped SOL
      let atomic = Math.floor(Number(intent.estTokens) * Math.pow(10, Number(decimals)));
      if (!Number.isFinite(atomic) || atomic <= 0) {
        throw new Error('Jumlah sell token tidak valid');
      }
      // Clamp to what the wallet ACTUALLY holds on-chain. The virtual ledger is a
      // mirror: it can drift ahead of the real balance (a partially-filled buy, a
      // manual transfer out). Selling more than we hold makes Jupiter build a tx
      // that fails simulation, so clamp down instead of failing the whole exit.
      const held = await getOnChainTokenAmount(kp.publicKey, intent.tokenAddress);
      if (held !== null && held > 0n) {
        // Clamp atomically with BigInt, but hand Jupiter a plain number (atomic units
        // are human-quantities × 10^decimals; a 6-decimal token at 1M tokens is
        // 1e12 atomic, far under MAX_SAFE_INTEGER 9.2e18). BigInt here only guards
        // the comparison, not the delivered value.
        if (BigInt(atomic) > held) {
          atomic = Number(held);
        }
      } else {
        // `null` = no account on EITHER token program, which is also what a
        // transient RPC failure looks like. Hard-blocking on it would strand
        // real funds in a position the guardian can no longer exit. The
        // transaction is simulated before broadcast below, so an over-estimated
        // amount fails there — costing no fee — rather than failing the sell
        // outright. Refuse only when the balance is a confirmed zero, which
        // means the wallet provably holds nothing to sell.
        if (held === 0n) {
          throw new Error('Hot wallet tidak memegang token ini on-chain — sell dibatalkan');
        }
        // held === null → unverifiable. Proceed and let simulation catch it.
      }
      inputMint = intent.tokenAddress;
      outputMint = SOL_MINT;
      amount = atomic;
    }

    // 1. Get quote (GET request with query params). Slippage: start at the safe
    // default, then escalate on a failed simulation so volatile memecoins
    // (pump.fun can move 5-10%/min) are not permanently blocked by a 1% cap.
    const SLIPPAGE_STEPS = [300, 600, 1000]; // bps: 3% → 6% → 10%
    let lastError = null;
    // Balance of the RECEIVING side before the swap, so the confirmed fill can
    // be measured as a delta rather than read as a total (see
    // readFilledOutputAmount). Best-effort: a failed read just means the quote
    // estimate is used instead.
    const beforeBalance = await (async () => {
      try {
        if (outputMint === SOL_MINT) {
          const lamports = await conn.getBalance(kp.publicKey);
          return BigInt(Math.max(0, Math.floor(lamports)));
        }
        return await getOnChainTokenAmount(kp.publicKey, outputMint);
      } catch {
        return null;
      }
    })();
    for (let si = 0; si < SLIPPAGE_STEPS.length; si++) {
      const slippageBps = SLIPPAGE_STEPS[si];
      try {
        const quote = await jupiterFetch(
          `/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}` +
          `&amount=${amount}&slippageBps=${slippageBps}`,
          {},
        );

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
        const sim = await conn.simulateTransaction(tx);
        if (sim.value?.err) {
          lastError = new Error(`Simulasi on-chain gagal (slippage ${slippageBps / 100}%): ${JSON.stringify(sim.value.err).slice(0, 160)}`);
          continue; // try higher slippage
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
          // Amount actually received, in human units, measured from the wallet's
          // on-chain balance rather than trusting Jupiter's quote. A quote is a
          // prediction made seconds before execution; on a volatile memecoin the
          // real fill can differ materially, and the position's cost basis is
          // derived from this — so a wrong cost basis would make every later
          // PnL, win-rate, and SL/TP decision wrong too.
          filledOutputAmount: await readFilledOutputAmount(conn, kp.publicKey, outputMint, outputDecimals, quote.outAmount, beforeBalance),
          slippageBps,
        };
      } catch (e) {
        lastError = e;
        // Non-slippage errors (network, decode, balance) are NOT retried at higher
        // slippage — rethrow immediately unless it looks like a simulation/swap risk.
        // Case-insensitive: Jupiter returns "SLIPPAGE_EXCEEDED", "Slippage tolerance
        // exceeded", "Transaction simulation failed: slippage" — all the same fault.
        const msg = String(e?.message ?? e).toLowerCase();
        const retriable =
          msg.includes('simulasi on-chain gagal') ||
          msg.includes('slippage') ||
          msg.includes('too little received') ||
          msg.includes('exact out amount') ||
          msg.includes('minimum of');
        if (!retriable) throw e;
      }
    }
    throw lastError ?? new Error('Jupiter swap gagal setelah beberapa slippage');
  } finally {
    // The decrypted keypair must not linger in the heap after the swap.
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
// 5_000_000 lamports (0.005 SOL) covers: ATA creation (~0.002 SOL) + tx fees
// (~0.001 SOL) + buffer for compute unit price fluctuation. The old 200_000
// (0.0002 SOL) was too small — Jupiter builds a tx that includes ATA creation
// when the wallet has never held the token, causing InsufficientFunds simulation.
export const HOT_WALLET_FEE_RESERVE_LAMPORTS = 5_000_000; // 0.005 SOL

/**
 * Total on-chain USD value of the hot wallet: SOL balance + every SPL token it
 * holds, priced via the DexScreener snapshot passed in (or fetched here).
 * Used by the equity curve so it tracks the REAL wallet, not the virtual ledger.
 * Returns null when the wallet does not exist or the SOL price is unknown.
 */
export async function getHotWalletTotalValue(userId, { solUsd, markets } = {}) {
  const info = getHotWalletPublicInfo(userId);
  if (!info.exists) return null;
  const conn = getSolanaConnection();
  const owner = new PublicKey(info.publicKey);

  let price = Number(solUsd);
  if (!Number.isFinite(price) || price <= 0) {
    const { getSolUsdPrice } = await import('./dexscreener.js');
    price = await getSolUsdPrice().catch(() => null);
  }
  if (!Number.isFinite(price) || price <= 0) return null;

  const lamports = await conn.getBalance(owner);
  let total = (lamports / 1e9) * price;

  // Enumerate SPL holdings (both token programs) and price what we can.
  const accounts = await getAllTokenAccounts(conn, owner);
  if (accounts.length > 0) {
    const mints = accounts
      .map((a) => a.account.data.parsed.info.mint)
      .filter((m) => m && m !== SOL_MINT);
    const priceMap = markets ?? await dexscreener.tokens(mints).catch(() => new Map());
    for (const a of accounts) {
      const parsed = a.account.data.parsed.info;
      const ui = Number(parsed.tokenAmount?.uiAmount) || 0;
      if (ui <= 0) continue;
      const norm = priceMap?.get?.(String(parsed.mint).toLowerCase());
      const tokenPrice = Number(norm?.priceUsd);
      if (Number.isFinite(tokenPrice) && tokenPrice > 0) total += ui * tokenPrice;
    }
  }
  return Math.round(total * 100) / 100;
}

/**
 * Value of the hot wallet's SPL tokens ONLY, excluding the SOL balance.
 *
 * Exposure is the risky part of a book: the SOL sitting in the wallet is
 * undeployed cash (and gas), not a position at risk. getHotWalletTotalValue
 * includes SOL, so using it as an exposure numerator would report ~100%
 * exposure on a wallet holding nothing but SOL. Returns null when no wallet.
 */
export async function getHotWalletTokenValue(userId, { markets } = {}) {
  const info = getHotWalletPublicInfo(userId);
  if (!info.exists) return null;
  const conn = getSolanaConnection();
  const owner = new PublicKey(info.publicKey);
  const accounts = await getAllTokenAccounts(conn, owner);
  const mints = accounts
    .map((a) => a.account.data.parsed.info.mint)
    .filter((m) => m && m !== SOL_MINT);
  if (mints.length === 0) return 0;
  const priceMap = markets ?? await dexscreener.tokens(mints).catch(() => new Map());
  let total = 0;
  for (const a of accounts) {
    const parsed = a.account.data.parsed.info;
    const ui = Number(parsed.tokenAmount?.uiAmount) || 0;
    if (ui <= 0) continue;
    const norm = priceMap?.get?.(String(parsed.mint).toLowerCase());
    const tokenPrice = Number(norm?.priceUsd);
    if (Number.isFinite(tokenPrice) && tokenPrice > 0) total += ui * tokenPrice;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Full portfolio snapshot of the hot wallet (SOL + each SPL holding with a
 * price, where DexScreener knows it). Backs the Portfolio page when hot-wallet
 * mode is active — the UI must show the hot wallet's books, never Phantom's.
 * Returns null when no wallet exists.
 */
export async function getHotWalletPortfolio(userId, { markets } = {}) {
  const info = getHotWalletPublicInfo(userId);
  if (!info.exists) return null;
  const conn = getSolanaConnection();
  const owner = new PublicKey(info.publicKey);

  const lamports = await conn.getBalance(owner);
  const solHeld = lamports / 1e9;

  const accounts = await getAllTokenAccounts(conn, owner);
  const mints = accounts
    .map((a) => a.account.data.parsed.info.mint)
    .filter((m) => m && m !== SOL_MINT);
  const priceMap = markets ?? await dexscreener.tokens(mints).catch(() => new Map());

  const tokens = [];
  for (const a of accounts) {
    const parsed = a.account.data.parsed.info;
    const mint = parsed.mint;
    if (!mint || mint === SOL_MINT) continue;
    const ui = Number(parsed.tokenAmount?.uiAmount) || 0;
    const decimals = Number(parsed.tokenAmount?.decimals) ?? 0;
    if (ui <= 0) continue;
    const norm = priceMap?.get?.(String(mint).toLowerCase());
    const priceUsd = Number(norm?.priceUsd);
    const valueUsd = Number.isFinite(priceUsd) && priceUsd > 0 ? ui * priceUsd : null;
    tokens.push({
      mint,
      symbol: norm?.symbol ?? `${mint.slice(0, 4).toUpperCase()}…`,
      name: norm?.baseToken?.name ?? null,
      uiAmount: ui,
      decimals: Number(parsed.tokenAmount?.decimals) ?? 0,
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
      valueUsd: valueUsd ? Math.round(valueUsd * 100) / 100 : null,
    });
  }
  tokens.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  return {
    exists: true,
    address: info.publicKey,
    solHeld,
    tokenCount: tokens.length,
    tokens,
  };
}

/**
 * Read the wallet's on-chain balance of an SPL token, in atomic units.
 *
 * Queries BOTH the legacy Token program and Token-2022. Jupiter routes across
 * both, so a token bought through this app can live in either program; checking
 * only the legacy one made every Token-2022 holding look like "no account",
 * which the caller reads as "holds nothing" and refuses to sell. That blocked
 * both autopilot exits and manual sells of Token-2022 tokens outright.
 *
 * Return contract — the caller distinguishes these, so they must stay distinct:
 *   > 0n  → confirmed balance held
 *   0n    → confirmed NOT held (queried successfully, no ATA or zero balance)
 *   null  → UNVERIFIABLE (every query threw). Not the same as "holds nothing".
 */
export async function getHotWalletTokenAmount(userId, mint) {
  const info = getHotWalletPublicInfo(userId);
  if (!info.exists) return 0n;
  return getOnChainTokenAmount(new PublicKey(info.publicKey), mint);
}

async function getOnChainTokenAmount(ownerPubkey, mint) {
  let mintPubkey;
  try {
    mintPubkey = new PublicKey(mint);
  } catch {
    return 0n; // malformed mint → provably nothing to sell
  }
  let total = 0n;
  let anyQuerySucceeded = false;
  for (const programId of TOKEN_PROGRAMS) {
    try {
      const accounts = await getSolanaConnection().getParsedTokenAccountsByOwner(ownerPubkey, {
        programId: new PublicKey(programId),
        mint: mintPubkey,
      });
      anyQuerySucceeded = true;
      for (const a of accounts.value ?? []) {
        const amt = Number(a.account.data.parsed.info.tokenAmount.amount);
        if (Number.isFinite(amt) && amt > 0) total += BigInt(Math.floor(amt));
      }
    } catch {
      // One program failing (unsupported filter, RPC hiccup) must not hide a
      // balance the other program can see. Tracked via anyQuerySucceeded.
    }
  }
  return anyQuerySucceeded ? total : null;
}

/**
 * Tokens the swap ACTUALLY delivered, in human units, as the DELTA of the
 * wallet's on-chain balance across the swap. A balance read alone is not enough:
 * if the wallet already held some of the output token, the total overstates what
 * this trade received, which would inflate the position's cost basis and make
 * every later PnL wrong. Falls back to the quote estimate when the RPC read is
 * unavailable, so a flaky node degrades to the old behaviour instead of failing
 * a trade that is already broadcast.
 */
async function readFilledOutputAmount(conn, owner, outputMint, outputDecimals, quotedOutAmount, before) {
  const scale = Math.pow(10, outputDecimals || 0);
  const estimate = Number(quotedOutAmount) / scale;
  const after = await (async () => {
    try {
      if (outputMint === SOL_MINT) {
        const lamports = await conn.getBalance(owner);
        return Number.isFinite(lamports) ? BigInt(Math.max(0, Math.floor(lamports))) : null;
      }
      return await getOnChainTokenAmount(owner, outputMint);
    } catch {
      return null;
    }
  })();
  if (after === null || before === null) return estimate;
  const delta = after - before;
  if (delta <= 0n) return estimate; // RPC lag or a fee-only tick — keep the estimate
  return Number(delta) / scale;
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
  if (!Number.isFinite(val) || val <= 0) return { ok: false, cap, reason: 'usdAmount tidak valid' };
  if (val > cap) return { ok: false, cap, reason: `Melebihi batas maksimal $${cap} USD per transaksi hot-wallet` };
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
    // Reserve for: priority fee (~50k) + rent exemption if closing account
    const FEE_BUFFER_LAMPORTS = 50_000;
    // Must keep account above rent-exempt minimum after the transfer
    const minRent = await conn.getMinimumBalanceForRentExemption(0);
    const maxSendable = balance - minRent - FEE_BUFFER_LAMPORTS;
    if (amount > maxSendable) {
      throw new Error(
        `Saldo tidak cukup: ${(balance / 1e9).toFixed(6)} SOL, maksimum tarik ${(maxSendable / 1e9).toFixed(6)} SOL ` +
        `(rent ${(minRent / 1e9).toFixed(6)} + fee reserve ${(FEE_BUFFER_LAMPORTS / 1e9).toFixed(6)})`,
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
