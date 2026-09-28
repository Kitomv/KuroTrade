import { useState } from 'react';
import { api, LeaderboardRow, AdminUser } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { IconAlert, IconStar } from '../components/Icons';
import { fmt } from '../lib/format';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { StaleBadge } from '../components/StaleBadge';
import { useEvmWallet } from '../components/EvmWalletContext';

export function Leaderboard({ role }: { role: 'admin' | 'user' }) {
  const { realMode } = useEvmWallet();
  const p = usePolling(() => api.leaderboard(), 15_000, []);
  const rows = p.data;
  const [adminUsers, setAdminUsers] = useState<AdminUser[] | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [err, setErr] = useState('');
  const [adminErr, setAdminErr] = useState('');
  const toast = useToast();
  const confirmAction = useConfirm();

  const loadAdmin = async () => {
    setAdminErr('');
    try {
      setAdminUsers(await api.adminUsers());
      setShowAdmin(true);
      setErr('');
    } catch (e: any) {
      setAdminErr(e.message ?? 'Gagal memuat daftar user');
    }
  };

  const handleReset = async (u: AdminUser) => {
    const pw = await confirmAction({
      title: `Reset Password ${u.username}`,
      message: 'Masukkan password baru (min 4 karakter).',
      confirmLabel: 'Reset',
      input: { label: 'Password baru', type: 'password', placeholder: '••••••••', required: true },
    });
    if (!pw) return;
    const newPw = String(pw);
    if (newPw.length < 4) { setErr('Password baru min 4 karakter'); return; }
    try {
      await api.adminResetPassword(u.id, newPw);
      toast.showToast(`Password ${u.username} direset`, 'success');
      setAdminErr('');
    } catch (e: any) {
      setAdminErr(e.message ?? 'Gagal reset password');
    }
  };

  const handleDelete = async (u: AdminUser) => {
    const ok = await confirmAction({
      title: `Hapus User ${u.username}?`,
      message: 'Semua data (wallet, posisi, watchlist, autopilot) akan ikut terhapus. Tindakan permanen.',
      confirmLabel: 'Ya, Hapus',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.adminDeleteUser(u.id);
      toast.showToast(`User ${u.username} dihapus`, 'success');
      setAdminUsers((prev) => prev?.filter((x) => x.id !== u.id) ?? null);
      setAdminErr('');
    } catch (e: any) {
      setAdminErr(e.message ?? 'Gagal menghapus user');
    }
  };

  const list: LeaderboardRow[] = rows ?? [];

  return (
    <>
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Leaderboard <StaleBadge stale={p.stale} /></h1>
          <p>Ranking portofolio semua user — nilai per harga terakhir tersimpan (refresh 15s).
            {realMode && <span style={{ color: 'var(--down)' }}> Ranking = portofolio VIRTUAL; wallet real tidak dihitung.</span>}
          </p>
        </div>
        {role === 'admin' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <button className="btn primary" style={{ fontSize: 13 }} onClick={loadAdmin}>Kelola User</button>
            {adminErr && <span className="error" style={{ margin: 0, fontSize: 11 }}><IconAlert size={12} /> {adminErr}</span>}
          </div>
        )}
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}><IconAlert size={14} /> {err}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th className="num">Total Portofolio</th>
                <th className="num">PnL %</th>
                <th className="num">Posisi</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.userId}>
                  <td style={{ fontWeight: 700, fontFamily: 'var(--font-heading)' }}>
                    {i === 0 ? <IconStar size={14} /> : i + 1}
                  </td>
                  <td>
                    <strong>{r.username}</strong>
                    {r.role === 'admin' && <span className="chip" style={{ marginLeft: 8, fontSize: 10 }}>admin</span>}
                  </td>
                  <td className="num">{fmt.usd(r.totalValue)}</td>
                  <td className="num">
                    <span className={`badge ${r.pnlPct >= 0 ? 'up' : 'down'}`}>
                      {r.pnlPct >= 0 ? '+' : ''}{r.pnlPct.toFixed(2)}%
                    </span>
                  </td>
                  <td className="num">{r.positionsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!list.length && <div className="empty"><span className="icon">🏆</span>Belum ada data user.</div>}
      </div>

      {/* Admin panel */}
      {showAdmin && adminUsers && (
        <Modal title={<><IconStar size={16} /> Kelola User ({adminUsers.length})</>} onClose={() => { setShowAdmin(false); setAdminErr(''); }} maxWidth={640}>
          {adminErr && <div className="error" style={{ marginBottom: 12 }}><IconAlert size={14} /> {adminErr}</div>}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th className="num">Saldo</th>
                  <th className="num">Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {adminUsers.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.username}</strong></td>
                    <td><span className="chip">{u.role}</span></td>
                    <td className="num">{fmt.usd(u.wallet.balance)}</td>
                    <td className="num">{fmt.usd(u.wallet.totalValue)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn icon" style={{ marginRight: 6, fontSize: 12 }} onClick={() => handleReset(u)}>Reset PW</button>
                      <button className="btn icon" style={{ color: 'var(--down)', background: 'rgba(239,68,68,.1)', fontSize: 12 }} onClick={() => handleDelete(u)}>Hapus</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}