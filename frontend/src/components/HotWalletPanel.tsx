// Hot Wallet control panel — server-side signing for 24/7 autopilot trading.
// The private key lives encrypted on the server (AES-256-GCM); this panel only
// ever sees the public key. Importers/callers: Portfolio.tsx, Agents.tsx.
// User instruction: "mau" (build the frontend UI for the hot wallet).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { IconAlert, IconCheck, IconKey, IconLock, IconPower, IconShield } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './ToastProvider';
import { shortAddr } from '../lib/solana';

interface Status {
  exists: boolean;
  publicKey: string | null;
}

export function HotWalletPanel({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const confirmAction = useConfirm();
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const [s, a, p] = await Promise.all([
        api.hotWalletStatus(),
        api.hotWalletAuto().catch(() => ({ autoEnabled: false })),
        api.hotWalletEmergencyPause().catch(() => ({ paused: false })),
      ]);
      setStatus(s);
      setAutoEnabled(Boolean(a.autoEnabled));
      setPaused(Boolean(p.paused));
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal memuat status hot wallet');
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

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
      const r = await api.hotWalletGenerate();
      toast.showToast(`Hot wallet dibuat: ${shortAddr(r.publicKey)}`, 'success');
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal membuat hot wallet');
    } finally {
      setBusy(null);
    }
  };

  const handleToggleAuto = async () => {
    if (!status?.exists) { setErr('Buat hot wallet dulu sebelum menyalakan auto-execute.'); return; }
    if (paused) { setErr('Emergency pause aktif — matikan dulu sebelum menyalakan auto-execute.'); return; }

    if (autoEnabled) {
      setBusy('auto');
      try {
        await api.setHotWalletAuto(false);
        setAutoEnabled(false);
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
      const r = await api.setHotWalletAuto(true);
      setAutoEnabled(Boolean(r.autoEnabled));
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
      const r = await api.setHotWalletEmergencyPause(next);
      setPaused(Boolean(r.paused));
      if (next) {
        setAutoEnabled(false);
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

  const wrapStyle = compact
    ? { display: 'flex', flexDirection: 'column' as const, gap: 8 }
    : { padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 12 };

  const body = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconKey size={15} />
          <strong style={{ fontSize: 14 }}>Hot Wallet (Auto-Execute 24/7)</strong>
        </div>
        <span
          className="chip"
          style={{
            background: paused ? 'rgba(239,68,68,.16)' : status?.exists ? 'var(--up-bg)' : 'var(--panel-2)',
            color: paused ? 'var(--down)' : status?.exists ? 'var(--up)' : 'var(--muted)',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {paused ? 'PAUSED' : status?.exists ? 'AKTIF' : 'BELUM ADA'}
        </span>
      </div>

      {status?.exists ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <IconLock size={12} />
          <span>Public key: <strong style={{ fontFamily: 'var(--font-heading)' }}>{shortAddr(status.publicKey ?? '', 6)}</strong></span>
          <span style={{ opacity: .7 }}>· private key tersimpan terenkripsi di server</span>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
          Belum ada hot wallet. Buat satu supaya autopilot bisa menandatangani transaksi sendiri
          (tanpa klik Approve di Phantom tiap order). Butuh <code>MASTER_ENCRYPTION_KEY</code> di backend <code>.env</code>.
        </p>
      )}

      {err && <div className="error" style={{ fontSize: 12, width: '100%' }}><IconAlert size={13} /> {err}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!status?.exists && (
          <button
            type="button"
            className="btn primary"
            style={{ fontSize: 12, minHeight: 36 }}
            disabled={busy !== null}
            onClick={handleGenerate}
          >
            {busy === 'generate' ? 'Membuat…' : 'Buat Hot Wallet'}
          </button>
        )}

        {status?.exists && (
          <button
            type="button"
            className="btn"
            style={{
              fontSize: 12,
              minHeight: 36,
              fontWeight: 700,
              background: autoEnabled ? 'rgba(239,68,68,.16)' : 'rgba(34,197,94,.16)',
              borderColor: autoEnabled ? 'rgba(239,68,68,.5)' : 'rgba(34,197,94,.5)',
              color: autoEnabled ? 'var(--down)' : 'var(--up)',
              opacity: paused ? .5 : 1,
            }}
            disabled={busy !== null || paused}
            onClick={handleToggleAuto}
          >
            <IconPower size={13} /> {busy === 'auto' ? 'Menyimpan…' : autoEnabled ? 'Auto-Execute ON' : 'Auto-Execute OFF'}
          </button>
        )}

        <button
          type="button"
          className="btn"
          style={{
            fontSize: 12,
            minHeight: 36,
            background: paused ? 'var(--panel-2)' : 'rgba(239,68,68,.12)',
            color: paused ? 'var(--text)' : 'var(--down)',
            borderColor: paused ? 'var(--border)' : 'rgba(239,68,68,.4)',
          }}
          disabled={busy !== null}
          onClick={handleEmergency}
        >
          <IconShield size={13} /> {busy === 'pause' ? 'Menyimpan…' : paused ? 'Matikan Emergency Pause' : 'EMERGENCY PAUSE'}
        </button>
      </div>

      {status?.exists && !compact && (
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