// EVM Hot Wallet for Multi-Chain Trading (Base first, manual execution).
// Self-contained: owns its own keystore file (data/evmwallets.json), same
// AES-256-GCM pattern + shared MASTER_ENCRYPTION_KEY as hotWallet.js. Uses
// ethers (secp256k1) + 1inch Aggregation for swaps on Base (chainId 8453).
// Importers/callers: server.js (/api/real/evm/*). Manual-only for now — no
// auto-execute integration until the EVM happy path is proven on a small trade.
// User instruction: "buat biar bisa jadi trade multi chain" → Base first, manual.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { isEmergencyPaused } from './hotWallet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const KEYS_FILE = () => process.env.EVM_WALLET_KEYS_FILE || join(DATA_DIR, 'evmwallets.json');
const ENCRYPTION_KEY_SIZE_BYTES = 32;
const NONCE_SIZE_BYTES = 12;

// --- Chain config (Base first; extend the map to add ETH/Arb/BSC later) ---
const CHAINS = {
  base: {
    chainId: 8453,
    rpc: () => process.env.BACKEND_BASE_RPC || 'https://mainnet.base.org',
    native: 'ETH',
    explorer: 'https://basescan.org/tx/',
    // 1inch aggregator needs an API key (free tier): INCH_API_KEY.
    inch: {
      base: 'https://api.1inch.dev/swap/v6.0/8453',
      key: () => process.env.INCH_API_KEY || '',
    },
    erc20Abi: ['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'],
  },
};

/** Get the EVM provider for a chain. */
export function getProvider(chain = 'base') {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Chain ${chain} tidak didukung`);
  return new ethers.JsonRpcProvider(cfg.rpc());
}

function ensureDataDir() {
  mkdirSync(dirname(KEYS_FILE()), { recursive: true });
}

/** Master key — same env var as the Solana hot wallet. */
export function getMasterKey() {
  const k = process.env.MASTER_ENCRYPTION_KEY;
  if (!k || String(k).trim().length < 16) throw new Error('MASTER_ENCRYPTION_KEY belum diset di .env');
  return String(k).trim();
}

/** Per-user AES key scoped by userId (same pattern as hotWallet.js). */
function deriveKey(userId, masterKey) {
  if (!userId || typeof userId !== 'string') throw new Error('userId required');
  return scryptSync(masterKey, `evmwallet:${userId}`, ENCRYPTION_KEY_SIZE_BYTES);
}

function loadKeystores() {
  ensureDataDir();
  try {
    if (!existsSync(KEYS_FILE())) return new Map();
    const raw = JSON.parse(readFileSync(KEYS_FILE(), 'utf-8'));
    const list = Array.isArray(raw?.keystores) ? raw.keystores : [];
    const map = new Map();
    for (const e of list) {
      if (e?.userId && e.address && e.ciphertext && e.iv && e.tag) {
        map.set(e.userId, { ...e, createdAt: Number(e.createdAt) || Date.now(), updatedAt: Number(e.updatedAt) || Date.now() });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveKeystores(map) {
  ensureDataDir();
  const target = KEYS_FILE();
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ keystores: Array.from(map.values()) }, null, 2), 'utf-8');
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function saveEncryptedWallet(userId, privateKeyHex, masterKey) {
  const derivedKey = deriveKey(userId, masterKey);
  const iv = randomBytes(NONCE_SIZE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  // privateKeyHex is 0x + 64 hex chars = 66 chars → 33 bytes. Strip 0x for storage.
  const secretBuffer = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const encrypted = Buffer.concat([cipher.update(secretBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wallet = new ethers.Wallet(privateKeyHex);

  const map = loadKeystores();
  const now = Date.now();
  const record = {
    userId,
    address: wallet.address.toLowerCase(),
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    createdAt: map.get(userId)?.createdAt ?? now,
    updatedAt: now,
  };
  const existing = map.get(userId);
  if (existing?.address && existing.address !== record.address) {
    throw new Error('EVM wallet sudah ada untuk user ini — hapus dulu jika mau ganti (dana lama tidak bisa diakses)');
  }
  map.set(userId, record);
  saveKeystores(map);
  // Zero key material in memory.
  secretBuffer.fill(0);
  return { address: record.address, createdAt: record.createdAt };
}

/** Generate a fresh EVM wallet (Base) for userId. */
export function generateEvmWallet(userId, masterKey = getMasterKey()) {
  const wallet = ethers.Wallet.createRandom();
  return saveEncryptedWallet(userId, wallet.privateKey, masterKey);
}

/** Import an existing EVM private key (0x-hex or bare 64-hex). */
export function importEvmWallet(userId, privateKeyHex, masterKey = getMasterKey()) {
  const clean = String(privateKeyHex).replace(/^0x/, '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('Private key tidak valid — harus 64 hex char');
  const wallet = new ethers.Wallet(`0x${clean}`);
  return saveEncryptedWallet(userId, wallet.privateKey, masterKey);
}

/** Decrypt + return an ethers.Wallet (caller must zero wallet.privateKey after). */
export function decryptEvmWallet(userId, masterKey = getMasterKey()) {
  const map = loadKeystores();
  const record = map.get(userId);
  if (!record) throw new Error(`EVM wallet untuk user ${userId} belum dibuat`);
  const derivedKey = deriveKey(userId, masterKey);
  const decipher = createDecipheriv('aes-256-gcm', derivedKey, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  try {
    const decrypted = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
    const wallet = new ethers.Wallet(`0x${decrypted.toString('hex')}`);
    decrypted.fill(0);
    derivedKey.fill(0);
    return wallet;
  } catch {
    derivedKey.fill(0);
    throw new Error('Gagal mendekripsi EVM wallet: MASTER_ENCRYPTION_KEY tidak cocok atau data corrupt');
  }
}

/** Public status (no secrets). */
export function getEvmWalletStatus(userId) {
  const record = loadKeystores().get(userId);
  if (!record) return { exists: false, address: null };
  return { exists: true, address: record.address, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

/** Native-token (ETH) balance of the EVM hot wallet on the given chain. */
export async function getEvmBalance(userId, chain = 'base') {
  const info = getEvmWalletStatus(userId);
  if (!info.exists) return { exists: false, address: null, balanceNative: '0' };
  const provider = getProvider(chain);
  const wei = await provider.getBalance(info.address);
  return { exists: true, address: info.address, balanceNative: wei.toString() };
}

/** Token (ERC-20) balance in atomic units, or null if no balanceOf for contract. */
export async function getEvmTokenBalance(userId, tokenAddress, chain = 'base') {
  const info = getEvmWalletStatus(userId);
  if (!info.exists || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return null;
  const cfg = CHAINS[chain];
  const provider = getProvider(chain);
  try {
    const contract = new ethers.Contract(tokenAddress, cfg.erc20Abi, provider);
    return (await contract.balanceOf(info.address)).toString();
  } catch {
    return null;
  }
}

async function inchFetch(path, chain = 'base') {
  const cfg = CHAINS[chain];
  const key = cfg.inch.key();
  if (!key) throw new Error('INCH_API_KEY belum diset di .env — gratis di https://portal.1inch.dev');
  const res = await fetch(`${cfg.inch.base}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`1inch ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const ZERO_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * Quote a swap on the configured chain. `amount` is in atomic units of `src`.
 * src/dst use the 1inch convention: native token = 0xEEE...EEE.
 */
export async function evmQuote(userId, { src, dst, amount, chain = 'base' }, { masterKey = getMasterKey() } = {}) {
  const wallet = decryptEvmWallet(userId, masterKey);
  try {
    const params = new URLSearchParams({ src, dst, amount: String(amount), from: wallet.address });
    return await inchFetch(`/quote?${params}`, chain);
  } finally {
    wallet.privateKey = '';
  }
}

/**
 * Execute a manual EVM swap on Base via 1inch Aggregation.
 * Steps: emergency pause → spend-permission check → ERC-20 approve (auto, only
 * if src is a token) → sign swap tx → broadcast. Manual-only.
 */
export async function executeEvmSwap(userId, { src, dst, amount, slippage = 100, chain = 'base' }, { masterKey = getMasterKey() } = {}) {
  if (isEmergencyPaused()) throw new Error('Circuit Breaker: Emergency Pause aktif. Semua transaksi EVM dihentikan.');

  const wallet = decryptEvmWallet(userId, masterKey);
  const provider = getProvider(chain);
  try {
    const from = wallet.address;

    // 1. Request swap tx from 1inch.
    const params = new URLSearchParams({
      src, dst, amount: String(amount), from,
      slippage: String(slippage), // basis points (1% = 100)
      disableEstimate: 'true',
    });
    const swapResp = await inchFetch(`/swap?${params}`, chain);
    const txData = swapResp?.tx;
    if (!txData?.to || !txData?.data) throw new Error('1inch tidak mengembalikan data transaksi swap');

    // 2. ERC-20 allowance: if src is a token (not native), ensure allowance.
    if (src.toLowerCase() === ZERO_ADDRESS) {
      // Native → no approve needed.
    } else {
      const cfg = CHAINS[chain];
      const contract = new ethers.Contract(src, cfg.erc20Abi, provider);
      const allowance = await contract.allowance(from, txData.to);
      if (BigInt(allowance) < BigInt(amount)) {
        const spender = txData.to;
        const approveTx = await contract.approve.populateTransaction(spender, ethers.MaxUint256);
        approveTx.from = from;
        approveTx.chainId = cfg.chainId;
        approveTx.nonce = await provider.getTransactionCount(from);
        const signedApprove = await wallet.signTransaction(approveTx);
        const approveRes = await provider.broadcastTransaction(signedApprove);
        await approveRes.wait();
        // New approval is now in the mempool — retry the swap after a short wait.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // 3. Build + sign the swap tx (1inch returns {from,to,data,value,gas,...}).
    const build = {
      to: txData.to,
      data: txData.data,
      value: txData.value ? BigInt(txData.value) : 0n,
      chainId: CHAINS[chain].chainId,
      nonce: await provider.getTransactionCount(from),
    };
    if (txData.gasPrice) build.gasPrice = BigInt(txData.gasPrice);
    if (txData.gas) build.gasLimit = BigInt(txData.gas);
    const signed = await wallet.signTransaction(build);
    const tx = await provider.broadcastTransaction(signed);
    const receipt = await tx.wait();

    return {
      ok: true,
      txHash: tx.hash,
      explorer: CHAINS[chain].explorer + tx.hash,
      chain,
      from,
      src,
      dst,
      amount: String(amount),
    };
  } finally {
    wallet.privateKey = '';
  }
}