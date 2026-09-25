// EVM (Base) Hot Wallet panel — MANUAL execution only.
// The server signs with an encrypted key (same AES-GCM keystore pattern as the
// Solana hot wallet); this panel never sees the private key. Swaps route through
// 1inch on Base and require an explicit confirm dialog — no auto-execute yet.
// Importers/callers: Settings.tsx (via MultiChainWalletPanel tab switcher).
import { useState } from 'react';
import { useEvmWallet } from './EvmWalletContext';
import { IconAlert, IconKey, IconLock, IconCopy, IconCheck } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './ToastProvider';

/** Shorten a 0x address for display: 0x1234…abcd */
function shortEvm(addr: string, chars = 4) {
  return addr.length > chars * 2 + 2 ? `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}` : addr;
}

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

export function EvmWalletPanel() {
  const { status, balanceEth, loading, error, generate, importKey, refresh } = useEvmWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const confirmAction = useConfirm();
  const toast = useToast();

  const exists = Boolean(status?.exists);
  const address = status?.address ?? null;

  const handleGenerate = async () => {
    const ok = await confirmAction({
      title: 'Buat EVM Wallet Baru (Base)?',
      message:
        'Server akan membuat keypair EVM (secp256k1) dan menyimpan private key-nya TERENKRIPSI (AES-256-GCM). ' +
        'Wallet ini dipakai untuk swap manual di Base via 1inch. Pastikan MASTER_ENCRYPTION_KEY sudah di-backup.',
      confirmLabel: 'Buat Wallet',
      danger: true,
    });
    if (!ok) return;
    setBusy('generate');
    setErr('');
    try {
      await generate();
      toast.showToast('EVM wallet dibuat', 'success');
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal membuat EVM wallet');
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    const input = await confirmAction({
      title: 'Import EVM Private Key',
      message: 'Tempel private key EVM (0x… atau 64 hex char). Server menyimpannya TERENKRIPSI untuk menandatangani swap Base.',
      confirmLabel: 'Lanjut',
      input: { label: 'Private key (0x… / 64 hex)', type: 'password', required: true },
    });
    if (!input) return;
    setBusy('import');
    setErr('');
    try {
      await importKey(String(input));
      toast.showToast('EVM wallet di-import', 'success');
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal import private key');
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    if (!address) return;
    const ok = await copyAddress(address);
    toast.showToast(ok ? 'Alamat disalin' : 'Gagal menyalin', ok ? 'success' : 'error');
  };

  // ETH balance is wei (string) — format to 6 decimals for display.
  const ethDisplay = (() => {
    try {
      const wei = BigInt(balanceEth || '0');
      return (Number(wei) / 1e18).toFixed(6);
    } catch {
      return '0.000000';
    }
  })();

  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconKey size={15} />
          <strong style={{ fontSize: 14 }}>EVM Wallet — Base</strong>
        </div>
        <span
          className="chip"
          style={{
            background: exists ? 'var(--up-bg)' : 'var(--panel-2)',
            color: exists ? 'var(--up)' : 'var(--muted)',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {loading ? '…' : exists ? 'AKTIF' : 'BELUM ADA'}
        </span>
      </div>

      {exists && address ? (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <IconLock size={12} />
            <span style={{ fontFamily: 'var(--font-heading)' }}>{shortEvm(address, 6)}</span>
            <button
              type="button"
              className="btn icon"
              style={{ minHeight: 24, padding: '1px 6px', fontSize: 11 }}
              onClick={handleCopy}
              title="Copy alamat"
            >
              <IconCopy size={11} />
            </button>
          </div>
          <div style={{ fontSize: 13 }}>
            Saldo: <strong>{ethDisplay} ETH</strong> <span style={{ color: 'var(--muted)', fontSize: 11 }}>(Base)</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
            Swap manual di Base via 1inch. Kirim ETH ke alamat di atas untuk biaya gas + swap.
            Butuh <code>INCH_API_KEY</code> di backend <code>.env</code>.
          </p>
        </>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
          Belum ada EVM wallet. Buat atau import satu untuk trading manual di Base (via 1inch).
          Butuh <code>MASTER_ENCRYPTION_KEY</code> dan <code>INCH_API_KEY</code> di backend <code>.env</code>.
        </p>
      )}

      {(err || error) && (
        <div className="error" style={{ fontSize: 12, width: '100%' }}>
          <IconAlert size={13} /> {err || error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!exists && (
          <>
            <button type="button" className="btn primary" style={{ fontSize: 12, minHeight: 36 }} disabled={busy !== null} onClick={handleGenerate}>
              {busy === 'generate' ? <><span className="spinner" aria-hidden /> Membuat…</> : 'Buat EVM Wallet'}
            </button>
            <button type="button" className="btn" style={{ fontSize: 12, minHeight: 36 }} disabled={busy !== null} onClick={handleImport}>
              {busy === 'import' ? <><span className="spinner" aria-hidden /> Mengimpor…</> : 'Import Private Key'}
            </button>
          </>
        )}
        {exists && (
          <button type="button" className="btn" style={{ fontSize: 12, minHeight: 36 }} disabled={loading} onClick={() => refresh()}>
            {loading ? <><span className="spinner" aria-hidden /> Memuat…</> : <><IconCheck size={13} /> Refresh Saldo</>}
          </button>
        )}
      </div>
    </div>
  );
}