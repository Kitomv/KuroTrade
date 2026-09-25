// Unit tests for EVM hot wallet (Base chain). Runs isolated from real keystores.
import { test } from 'node:test';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const TEMP_DIR = join(tmpdir(), `evm-test-${process.pid}`);
mkdirSync(TEMP_DIR, { recursive: true });
process.env.EVM_WALLET_KEYS_FILE = join(TEMP_DIR, 'evmwallets.json');

const TEST_MASTER_KEY = randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import {
  generateEvmWallet,
  importEvmWallet,
  getEvmWalletStatus,
  decryptEvmWallet,
} from './evmWallet.js';

test('generate & decrypt round-trip produces identical EVM address', () => {
  const userId = `evm_user_${Date.now()}_a`;
  const gen = generateEvmWallet(userId, TEST_MASTER_KEY);
  if (!gen.address || !/^0x[0-9a-fA-F]{40}$/.test(gen.address)) {
    throw new Error('Alamat EVM tidak valid');
  }

  const info = getEvmWalletStatus(userId);
  if (!info.exists || info.address !== gen.address) {
    throw new Error('Status address mismatch');
  }

  const wallet = decryptEvmWallet(userId, TEST_MASTER_KEY);
  if (wallet.address.toLowerCase() !== gen.address.toLowerCase()) {
    throw new Error('Decrypted wallet address mismatch');
  }
});

test('different users have isolated EVM keys under same master', () => {
  const u1 = `evm_u1_${Date.now()}`;
  const u2 = `evm_u2_${Date.now()}`;
  const g1 = generateEvmWallet(u1, TEST_MASTER_KEY);
  const g2 = generateEvmWallet(u2, TEST_MASTER_KEY);
  if (g1.address.toLowerCase() === g2.address.toLowerCase()) {
    throw new Error('Alamat harus berbeda per-user');
  }

  const w1 = decryptEvmWallet(u1, TEST_MASTER_KEY);
  const w2 = decryptEvmWallet(u2, TEST_MASTER_KEY);
  if (w1.address.toLowerCase() !== g1.address.toLowerCase()) throw new Error('u1 mismatch');
  if (w2.address.toLowerCase() !== g2.address.toLowerCase()) throw new Error('u2 mismatch');
});

test('wrong master key rejects EVM decryption', () => {
  const userId = `evm_wrong_${Date.now()}`;
  generateEvmWallet(userId, TEST_MASTER_KEY);
  const wrongKey = randomBytes(32).toString('hex');
  try {
    decryptEvmWallet(userId, wrongKey);
    throw new Error('Harus menolak wrong key');
  } catch (e) {
    if (!String(e.message).includes('MASTER_ENCRYPTION_KEY tidak cocok')) throw e;
  }
});

test('import private key (hex) preserves address', () => {
  const userId = `evm_import_${Date.now()}`;
  // Standard hardhat well-known private key for tests (0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
  const pk = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const expectedAddr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'.toLowerCase();

  const imported = importEvmWallet(userId, pk, TEST_MASTER_KEY);
  if (imported.address.toLowerCase() !== expectedAddr) {
    throw new Error(`Import address mismatch: ${imported.address} vs ${expectedAddr}`);
  }

  const decrypted = decryptEvmWallet(userId, TEST_MASTER_KEY);
  if (decrypted.address.toLowerCase() !== expectedAddr) {
    throw new Error('Decrypted address mismatch');
  }
});