// Settings page — dangerous / rarely-used account + wallet controls live here
// instead of on the trading pages, so an accidental click can't create, replace,
// or drain a hot wallet while someone is trading. Also hosts Change Password and
// Logout (moved out of the sidebar to reduce mis-clicks).
// Importers/callers: App.tsx (page router + auth handlers). API: HotWalletPanel
// via HotWalletContext, useRealWallet(), and the onChangePassword/onLogout props.
// User instruction: "mending kasih menu pengaturan di side bar user buat nyimpen
// menu hot wallet biar aman antisipasi salah pencet" + "change password juga sama
// log out masukin menu pengaturan".
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { HotWalletPanel } from '../components/HotWalletPanel';
import { useRealWallet } from '../components/RealWalletContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { IconAlert, IconGear, IconKey, IconShield, IconWallet } from '../components/Icons';

interface Props {
  username?: string;
  role?: 'admin' | 'user';
  onChangePassword?: (current: string, next: string) => Promise<void>;
  onLogout?: () => void;
}

export function Settings({ username, role, onChangePassword, onLogout }: Props) {
  const { connected, isBound, realMode } = useRealWallet();
  const confirmAction = useConfirm();
  const toast = useToast();

  // Change-password form (moved from Sidebar).
  const [showPw, setShowPw] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const submitPw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onChangePassword) return;
    if (newPw.length < 8) { setPwErr('Password baru minimal 8 karakter'); return; }
    setPwBusy(true);
    setPwErr('');
    try {
      await onChangePassword(curPw, newPw);
      setShowPw(false);
      setCurPw('');
      setNewPw('');
      toast.showToast('Password berhasil diubah', 'success');
    } catch (ex: any) {
      setPwErr(ex.message ?? 'Gagal ganti password');
    } finally {
      setPwBusy(false);
    }
  };

  const handleLogout = async () => {
    const ok = await confirmAction({
      title: 'Logout?',
      message: 'Kamu akan keluar dari sesi ini. Autopilot & hot wallet tetap berjalan di server.',
      confirmLabel: 'Logout',
      danger: true,
    });
    if (ok) onLogout?.();
  };

  return (
    <>
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h1 style={{ margin: 0 }}>Pengaturan</h1>
          <span className="chip" style={{ background: 'var(--panel-2)', color: 'var(--muted)', fontSize: 11 }}>
            <IconGear size={12} /> Advanced
          </span>
          {username && (
            <span className="chip" style={{ background: 'var(--panel-2)', color: 'var(--muted)', fontSize: 11 }}>
              {username}{role === 'admin' ? ' · admin' : ''}
            </span>
          )}
        </div>
        <p>Kontrol wallet &amp; akun. Dipisah dari halaman trading supaya tidak salah pencet.</p>
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 24, borderLeft: '3px solid var(--accent)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <IconAlert size={16} />
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <strong>Hati-hati.</strong> Kontrol di halaman ini mengubah wallet yang dipakai autopilot
            untuk bergerak dengan dana asli. Hot wallet tidak bisa dibuat ulang kalau sudah ada —
            dana di alamat lama akan tidak bisa diakses.
          </div>
        </div>
      </div>

      {/* Hot Wallet — moved off the trading pages */}
      <div style={{ marginBottom: 24 }}>
        <HotWalletPanel />
      </div>

      {/* Status ringkas */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconWallet size={15} /> Status Wallet
        </div>
        <div style={{ padding: 20, display: 'grid', gap: 10, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--muted)' }}>Phantom</span>
            <strong>{connected ? (isBound ? 'Terhubung & ter-bind' : 'Terhubung, belum bind') : 'Belum terhubung'}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--muted)' }}>Mode</span>
            <strong>{realMode ? 'REAL (dana asli)' : 'VIRTUAL'}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--muted)' }}>Eksekusi otomatis</span>
            <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconKey size={13} /> Hot Wallet (panel di atas)
            </strong>
          </div>
        </div>
      </div>

      {/* Account — change password + logout (moved from Sidebar) */}
      <div className="card">
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconShield size={15} /> Akun
        </div>
        <div style={{ padding: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn" style={{ fontSize: 13 }} onClick={() => setShowPw(true)}>
            Ganti Password
          </button>
          <button
            type="button"
            className="btn"
            style={{ fontSize: 13, background: 'rgba(239,68,68,.14)', borderColor: 'rgba(239,68,68,.4)', color: 'var(--down)' }}
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      </div>

      {showPw && (
        <Modal title="Ganti Password" onClose={() => { setShowPw(false); setPwErr(''); }} maxWidth={380}>
          <form onSubmit={submitPw} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
              PASSWORD LAMA
              <input type="password" className="input" style={{ width: '100%' }} value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" required />
            </label>
            <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
              PASSWORD BARU
              <input type="password" className="input" style={{ width: '100%' }} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required />
            </label>
            {pwErr && <div className="error" style={{ margin: 0 }}>{pwErr}</div>}
            <button type="submit" className="btn primary" style={{ width: '100%', minHeight: 42, fontWeight: 700 }} disabled={pwBusy}>
              {pwBusy ? 'Menyimpan…' : 'Simpan Password Baru'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
