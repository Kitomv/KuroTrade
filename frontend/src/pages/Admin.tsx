// Admin page — account management, and the ONLY way a user comes into being.
//
// There is no self-registration: the login page tells people to ask an admin,
// so this page is where that request gets fulfilled. Every route it calls
// re-checks the admin role on the server (403 otherwise), so the role gate in
// App/Sidebar is a convenience, not the access control.
//
// An account with no password (a record from the removed wallet-login flow) can
// no longer log in at all — the reset action is what makes it usable again,
// which is why the table calls that state out instead of hiding it.
//
// Importers/callers: App.tsx (page router, admin-only branch).
import { useState } from 'react';
import { api, AdminUserRow } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { Modal } from '../components/Modal';
import { StaleBadge } from '../components/StaleBadge';
import { useToast } from '../components/ToastProvider';
import { IconUserPlus, IconShield, IconKey } from '../components/Icons';
import { newUserError, passwordError, USERNAME_MIN, PASSWORD_MIN } from '../lib/adminView';

const when = (ts?: number) => (ts ? new Date(ts).toLocaleString() : '—');

/** A password field with a reveal toggle — an admin has to read back whatever
 *  they set, since it is handed to someone else. */
function PasswordField({ id, label, value, onChange, autoComplete }: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }}>
      <label htmlFor={id} style={{ flex: 1, minWidth: 0 }}>
        <span className="modal-label">{label}</span>
        <input
          id={id}
          className="input"
          style={{ width: '100%' }}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
        />
      </label>
      <button
        type="button"
        className="btn"
        style={{ minHeight: 42, flex: 'none' }}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Sembunyikan' : 'Lihat'}
      </button>
    </div>
  );
}

export function Admin({ currentUserId }: { currentUserId?: string }) {
  const toast = useToast();
  // Bumping `key` restarts the poller with an immediate tick, so a new account
  // appears at once instead of up to 15s later.
  const [key, setKey] = useState(0);
  const p = usePolling(() => api.adminUsers(), 15_000, [key]);
  const users: AdminUserRow[] = p.data?.users ?? [];

  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [resetFor, setResetFor] = useState<AdminUserRow | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetErr, setResetErr] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = newUserError(name, pw);
    if (invalid) { setErr(invalid); return; }
    setBusy(true);
    setErr('');
    try {
      const created = await api.adminCreateUser({ username: name.trim(), password: pw });
      setName('');
      setPw('');
      setKey((k) => k + 1);
      toast.showToast(`Akun ${created.username} dibuat`, 'success');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Gagal membuat akun');
    } finally {
      setBusy(false);
    }
  };

  const closeReset = () => { setResetFor(null); setResetPw(''); setResetErr(''); };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetFor) return;
    const invalid = passwordError(resetPw);
    if (invalid) { setResetErr(invalid); return; }
    setResetBusy(true);
    setResetErr('');
    try {
      await api.adminSetPassword(resetFor.id, resetPw);
      const who = resetFor.username ?? 'akun';
      closeReset();
      setKey((k) => k + 1);
      // The server revokes that account's other sessions, so this really does
      // cut off whoever was using it.
      toast.showToast(`Password ${who} diganti`, 'success');
    } catch (ex: unknown) {
      setResetErr(ex instanceof Error ? ex.message : 'Gagal mengganti password');
    } finally {
      setResetBusy(false);
    }
  };

  const loadFailed = !p.data && p.stale;

  return (
    <>
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <IconShield size={20} /> Admin <StaleBadge stale={p.stale} />
        </h1>
        <p>
          Tambah akun dan atur ulang password. Tidak ada pendaftaran mandiri —
          akun hanya dibuat dari halaman ini.
        </p>
      </div>

      <div className="responsive-split" style={{ marginBottom: 24 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <IconUserPlus size={15} />
            <strong style={{ fontSize: 14 }}>Tambah User</strong>
          </div>
          <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.55 }}>
            Akun baru selalu ber-role <strong>user</strong>. Role admin hanya bisa
            diberikan lewat konfigurasi server.
          </p>

          <form onSubmit={createUser} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label htmlFor="admin-new-username">
              <span className="modal-label">Username</span>
              <input
                id="admin-new-username"
                className="input"
                style={{ width: '100%' }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${USERNAME_MIN}–32 karakter`}
                autoComplete="off"
                required
              />
            </label>

            <PasswordField
              id="admin-new-password"
              label={`Password (min ${PASSWORD_MIN})`}
              value={pw}
              onChange={setPw}
              autoComplete="new-password"
            />

            {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}

            <button type="submit" className="btn primary" style={{ minHeight: 42, fontWeight: 700 }} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? 'Membuat…' : 'Buat Akun'}
            </button>
          </form>
        </div>

        <div className="card">
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>
            Daftar User <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({users.length})</span>
          </div>

          {loadFailed ? (
            <div className="error" role="alert" style={{ margin: 16 }}>
              Gagal memuat daftar user. Halaman ini khusus admin — muat ulang
              halaman, dan pastikan akunmu masih ber-role admin.
            </div>
          ) : !p.data ? (
            <div className="empty">Memuat…</div>
          ) : !users.length ? (
            <div className="empty"><span className="icon"><IconUserPlus size={28} /></span>Belum ada akun lain.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Password</th>
                    <th>Dibuat</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = Boolean(currentUserId) && u.id === currentUserId;
                    return (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.username ?? '—'}</strong>
                          {u.address && (
                            <div style={{ color: 'var(--dim)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                              {u.address.slice(0, 10)}…{u.address.slice(-6)}
                            </div>
                          )}
                          {isSelf && <div style={{ color: 'var(--muted)', fontSize: 11 }}>akun Anda</div>}
                        </td>
                        <td>
                          {u.role === 'admin'
                            ? <span className="chip" style={{ color: 'var(--accent)', borderColor: 'rgba(232,163,61,.4)' }}>Admin</span>
                            : <span className="chip">User</span>}
                        </td>
                        <td>
                          {u.hasPassword
                            ? <span className="badge up">Ada</span>
                            : <span className="badge down">Belum</span>}
                        </td>
                        <td style={{ color: 'var(--muted)', fontSize: 12 }}>{when(u.createdAt)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {/* Own password goes through Pengaturan, which verifies
                              the current one — and an admin reset revokes every
                              session including this one, so offering it here
                              would just log the admin out. */}
                          {!isSelf && (
                            <button
                              type="button"
                              className="btn"
                              style={{ fontSize: 12, minHeight: 32 }}
                              onClick={() => setResetFor(u)}
                            >
                              <IconKey size={13} /> Reset Password
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {resetFor && (
        <Modal
          title={`Reset Password — ${resetFor.username ?? 'akun'}`}
          onClose={closeReset}
          maxWidth={420}
        >
          <p className="modal-text">
            Password lama tidak bisa ditampilkan (hanya hash yang disimpan). Set
            password baru, lalu berikan ke pemilik akun. Sesi login akun ini di
            perangkat lain langsung diputus.
          </p>
          <form onSubmit={submitReset} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <PasswordField
              id="admin-reset-password"
              label={`Password Baru (min ${PASSWORD_MIN})`}
              value={resetPw}
              onChange={setResetPw}
              autoComplete="new-password"
            />
            {resetErr && <p className="error" role="alert" style={{ margin: 0 }}>{resetErr}</p>}
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={closeReset}>Batal</button>
              <button type="submit" className="btn primary" style={{ flex: 1 }} disabled={resetBusy}>
                {resetBusy ? 'Menyimpan…' : 'Simpan Password'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
