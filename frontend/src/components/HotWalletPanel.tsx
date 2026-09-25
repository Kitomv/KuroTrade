// Hot Wallet control panel — server-side signing for 24/7 autopilot trading.
// The private key lives encrypted on the server (AES-256-GCM); this panel only
// ever sees the public key. Reads state from HotWalletContext (single poll at
// the shell level), so it reflects the same data as the global pause banner.
// Importers/callers: Portfolio.tsx, Agents.tsx.
// User instruction: "mau" (build the frontend UI for the hot wallet); UI pass:
// class-based styling, distinct pause vs auto states, fundable address + balance.
import { useState } from 'react';
import { api } from '../api/client';
import { useHotWallet } from './HotWalletContext';
import { IconAlert, IconArrowDown, IconCopy, IconKey, IconLock, IconPower, IconShield, IconCheck } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './ToastProvider';
import { shortAddr } from '../lib/solana';

const LOW_SOL_THRESHOLD = 0.02; // ~rent for a couple of accounts + fee buffer

/** Copy to clipboard, with a hidden-textarea fallback for insecure/tunnel origins. */
async function copyAddress(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 string to bytes (no dependency — bs58 is small enough to inline). */
function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of str) {
    const val = B58_ALPHABET.indexOf(ch);
    if (val === -1) throw new Error(`Karakter base58 tidak valid: "${ch}"`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's are leading zero bytes.
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/**
 * Parse a user-pasted private key into a 64-byte array.
 * Accepts base58 (Phantom export) or a JSON array of 64 numbers.
 */
function parseSecretKey(raw: string): number[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Private key kosong');

  // JSON array form: [12,34,...]
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try { arr = JSON.parse(trimmed); } catch { throw new Error('Format array JSON tidak valid'); }
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(`Array harus berisi 64 angka (dapat ${Array.isArray(arr) ? arr.length : 'bukan array'})`);
    }
    const nums = arr.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('Semua elemen array harus angka 0-255');
    }
    return nums;
  }

  // base58 form (Phantom "Export Private Key")
  const decoded = base58Decode(trimmed);
  if (decoded.length !== 64) {
    throw new Error(
      `Panjang key salah: ${decoded.length} byte, harus 64. ` +
      'Pastikan kamu menyalin PRIVATE KEY (bukan seed phrase 12/24 kata).',
    );
  }
  return Array.from(decoded);
}

export function HotWalletPanel({ compact = false }: { compact?: boolean }) {
  const { status, autoEnabled, paused, balanceSol, loading, error, generate, toggleAuto, pause, refresh } = useHotWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const confirmAction = useConfirm();
  const toast = useToast();

  const exists = Boolean(status?.exists);
  const pubkey = status?.publicKey ?? null;
  // Surface the network so nobody mistakes a devnet test wallet for real funds.
  const network = (status?.network ?? 'mainnet').toLowerCase();
  const isDevnet = network !== 'mainnet';

  const handleGenerate = async () => {
    const ok = await confirmAction({
      title: 'Buat Hot Wallet Baru?',
      message:
        'Server akan membuat keypair Solana baru dan menyimpan private key-nya TERENKRIPSI (AES-256-GCM). ' +
        'Wallet ini yang akan menandatangani transaksi autopilot tanpa popup Phantom. ' +
        'Pastikan MASTER_ENCRYPTION_KEY sudah di-backup — kalau hilang, key tidak bisa didekripsi.',
      confirmLabel: 'Buat Wallet',
      danger: true,
    });
    if (!ok) return;
    setBusy('generate');
    setErr('');
    try {
      await generate();
      toast.showToast(`Hot wallet dibuat: ${shortAddr(pubkey ?? '', 4)}`, 'success');
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal membuat hot wallet');
    } finally {
      setBusy(null);
    }
  };

    /**
   * Import an existing Solana private key instead of generating one.
   * Two accepted formats (both describe the SAME 64-byte Ed25519 keypair):
   *   - base58 string  — what Phantom's "Export Private Key" gives you
   *   - JSON array     — "[12,34,...]" (64 numbers), for keys copied as arrays
   * The key is sent to the server, encrypted, and never returned.
   */
  const handleImport = async () => {
    const input = await confirmAction({
      title: 'Import Private Key',
      message:
        'Tempel private key Solana (format base58 dari Phantom, atau array 64 angka). ' +
        'Server akan menyimpannya TERENKRIPSI (AES-256-GCM) untuk menandatangani transaksi autopilot. ' +
        'Kamu tetap memegang kunci aslinya — ini bukan penyerahan kepemilikan.',
      confirmLabel: 'Lanjut',
      input: { label: 'Private key (base58 atau [64 angka])', type: 'text', required: true },
    });
    if (!input) return;

    let bytes: number[];
    try {
      bytes = parseSecretKey(String(input));
    } catch (e: any) {
      setErr(e?.message ?? 'Format private key tidak dikenali');
      return;
    }

    setBusy('import');
    setErr('');
    try {
      const r = await api.hotWalletImport(bytes);
      toast.showToast(`Hot wallet di-import: ${shortAddr(r.publicKey, 4)}`, 'success');
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal import private key');
    } finally {
      setBusy(null);
    }
  };

  const handleToggleAuto = async () => {
    if (!exists) { setErr('Buat hot wallet dulu sebelum menyalakan auto-execute.'); return; }
    if (paused) { setErr('Emergency pause aktif — matikan dulu sebelum menyalakan auto-execute.'); return; }

    if (autoEnabled) {
      setBusy('auto');
      try {
        await toggleAuto(false);
        toast.showToast('Auto-execute hot wallet dimatikan', 'success');
      } catch (e: any) {
        setErr(e?.message ?? 'Gagal mematikan auto-execute');
      } finally {
        setBusy(null);
      }
      return;
    }

    const ok = await confirmAction({
      title: 'Nyalakan Auto-Execute Hot Wallet?',
      message:
        'SEMUA intent autopilot (BUY/SELL/SL/TP/rotasi) akan LANGSUNG dieksekusi on-chain oleh server ' +
        'TANPA konfirmasi Phantom. Dana asli bergerak otomatis 24/7. ' +
        'Batas: 5 transaksi/menit dan pagu USD per transaksi dari HOT_WALLET_MAX_USD_PER_TRADE.',
      confirmLabel: 'Ya, auto-execute',
      danger: true,
    });
    if (!ok) return;
    setBusy('auto');
    setErr('');
    try {
      await toggleAuto(true);
      toast.showToast('Auto-execute hot wallet NYALA — dana asli bergerak otomatis', 'error');
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal menyalakan auto-execute');
    } finally {
      setBusy(null);
    }
  };

  const handleEmergency = async () => {
    const next = !paused;
    if (next) {
      const ok = await confirmAction({
        title: 'EMERGENCY PAUSE?',
        message: 'Menghentikan SEMUA eksekusi hot-wallet seketika (global). Tidak ada trade otomatis sampai dinyalakan lagi.',
        confirmLabel: 'PAUSE sekarang',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy('pause');
    setErr('');
    try {
      await pause(next);
      if (next) {
        toast.showToast('EMERGENCY PAUSE AKTIF — semua trade otomatis dihentikan', 'error');
      } else {
        toast.showToast('Emergency pause dimatikan', 'success');
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal mengubah emergency pause');
    } finally {
      setBusy(null);
    }
  };

  const handleWithdraw = async () => {
    if (balanceSol <= 0) return;
    const ok = await confirmAction({
      title: 'Tarik SEMUA SOL ke Phantom?',
      message:
        'Server menghitung jumlah maksimum yang bisa ditarik (saldo penuh dikurangi buffer fee), ' +
        'lalu mengirimkannya ke wallet Phantom yang sudah di-bind. ' +
        'Saldo akan habis dan autopilot tidak bisa trading sampai diisi ulang. ' +
        'Kalau wallet belum di-bind, tarik akan ditolak.',
      confirmLabel: 'Ya, tarik semua',
      danger: true,
    });
    if (!ok) return;
    setBusy('withdraw');
    setErr('');
    try {
      const r = await api.hotWalletWithdrawAll();
      toast.showToast(`Tarik berhasil — ${(r.lamports / 1e9).toFixed(6)} SOL terkirim ke ${shortAddr(r.to, 4)}`, 'success');
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal menarik saldo');
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    if (!pubkey) return;
    const ok = await copyAddress(pubkey);
    toast.showToast(ok ? 'Alamat hot wallet disalin' : 'Gagal menyalin — salin manual dari teks di atas', ok ? 'success' : 'error');
  };

  const wrapStyle = compact
    ? { display: 'flex', flexDirection: 'column' as const, gap: 8 }
    : { padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 };

  const lowSol = exists && balanceSol < LOW_SOL_THRESHOLD;

  const body = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconKey size={15} />
          <strong style={{ fontSize: 14 }}>Hot Wallet (Auto-Execute 24/7)</strong>
          <span
            className="chip"
            style={{
              background: isDevnet ? 'rgba(56,189,248,.16)' : 'var(--panel-2)',
              color: isDevnet ? '#38bdf8' : 'var(--muted)',
              fontSize: 10,
              fontWeight: 700,
              border: isDevnet ? '1px solid rgba(56,189,248,.45)' : undefined,
            }}
            title={isDevnet ? 'Uang mainan (faucet) — bukan dana asli' : 'Dana asli on-chain'}
          >
            {network.toUpperCase()}
          </span>
        </div>
        <span
          className="chip"
          style={{
            background: paused ? 'rgba(239,68,68,.16)' : exists ? 'var(--up-bg)' : 'var(--panel-2)',
            color: paused ? 'var(--down)' : exists ? 'var(--up)' : 'var(--muted)',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {paused ? 'PAUSED' : exists ? 'AKTIF' : 'BELUM ADA'}
        </span>
      </div>

      {isDevnet && (
        <div style={{ fontSize: 12, color: '#38bdf8', background: 'rgba(56,189,248,.1)', border: '1px solid rgba(56,189,248,.35)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }} role="status">
          <IconAlert size={12} /> Mode TESTNET ({network}) — saldo &amp; trade pakai uang mainan, bukan dana asli. Ganti <code>NETWORK=mainnet</code> di backend <code>.env</code> untuk trading sungguhan.
        </div>
      )}

      {exists ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <IconLock size={12} />
          <span>Public key:</span>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
          Belum ada hot wallet. <strong>Buat</strong> (server generate, kunci terkunci di server) atau{' '}
          <strong>Import</strong> (pakai private key milikmu sendiri — kamu tetap pegang kuncinya).
          Keduanya membuat autopilot bisa menandatangani transaksi sendiri tanpa klik Approve di Phantom.
          Butuh <code>MASTER_ENCRYPTION_KEY</code> di backend <code>.env</code>.
        </p>
      )}

      {exists && pubkey && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <code className="hwp-key">{pubkey}</code>
          <button
            type="button"
            className="btn"
            style={{ minHeight: 32, padding: '4px 10px', fontSize: 12 }}
            onClick={handleCopy}
            aria-label="Salin alamat hot wallet"
            title="Salin alamat untuk top-up SOL"
          >
            <IconCopy size={13} />
            Salin
          </button>
          <span className="hwp-balance" title="Saldo SOL hot wallet (lihat konten untuk top-up)">
            {balanceSol.toFixed(4)} SOL
          </span>
          <button
            type="button"
            className="btn"
            style={{ minHeight: 32, padding: '4px 10px', fontSize: 12 }}
            onClick={handleWithdraw}
            disabled={busy !== null || balanceSol <= 0}
            title="Tarik SOL dari hot wallet kembali ke wallet Phantom yang di-bind"
          >
            <IconArrowDown size={13} />
            {busy === 'withdraw' ? 'Menarik…' : 'Tarik ke Phantom'}
          </button>
        </div>
      )}

      {lowSol && (
        <div style={{ fontSize: 12, color: 'var(--accent)', background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.4)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }} role="status">
          <IconAlert size={12} /> SOL di bawah biaya transaksi — kirim SOL ke alamat di atas supaya autopilot bisa jalan.
        </div>
      )}

      {loading && <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>Memuat status…</p>}

      {(err || error) && <div className="error" style={{ fontSize: 12, width: '100%' }}><IconAlert size={13} /> {err || error}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!exists && (
          <>
            <button
              type="button"
              className="btn primary"
              style={{ fontSize: 12, minHeight: 36 }}
              disabled={busy !== null}
              onClick={handleGenerate}
            >
              {busy === 'generate' ? 'Membuat…' : 'Buat Hot Wallet'}
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, minHeight: 36 }}
              disabled={busy !== null}
              onClick={handleImport}
              title="Pakai private key milikmu sendiri (dari Phantom) — kamu tetap pegang kuncinya"
            >
              {busy === 'import' ? 'Mengimpor…' : 'Import Private Key'}
            </button>
          </>
        )}

        {exists && (
          <button
            type="button"
            className={`btn ${autoEnabled ? 'btn-danger-on' : ''}`}
            style={{ fontSize: 12, minHeight: 36, fontWeight: 700 }}
            disabled={busy !== null || paused}
            onClick={handleToggleAuto}
            aria-pressed={autoEnabled}
          >
            {autoEnabled && <span className="hwp-dot" aria-hidden="true" />}
            <IconPower size={13} /> {busy === 'auto' ? 'Menyimpan…' : autoEnabled ? 'Auto-Execute ON' : 'Auto-Execute OFF'}
          </button>
        )}

        <button
          type="button"
          className={`btn ${paused ? 'btn-danger-solid' : 'btn-danger'}`}
          style={{ fontSize: 12, minHeight: 36 }}
          disabled={busy !== null}
          onClick={handleEmergency}
          aria-pressed={paused}
        >
          <IconShield size={13} /> {busy === 'pause' ? 'Menyimpan…' : paused ? 'Matikan Emergency Pause' : 'EMERGENCY PAUSE'}
        </button>
      </div>

      {exists && !compact && (
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <IconCheck size={11} /> Rate limit 5 tx/menit · pagu USD per transaksi dari <code>HOT_WALLET_MAX_USD_PER_TRADE</code> ·
          simulasi on-chain sebelum broadcast · SELL dibatalkan bila desimal token tak terverifikasi.
        </div>
      )}
    </>
  );

  if (compact) return <div style={wrapStyle}>{body}</div>;
  return <div className="card" style={wrapStyle}>{body}</div>;
}