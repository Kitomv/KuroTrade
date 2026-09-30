// Login page — registration is disabled (accounts are seeded from env on the
// backend). Importers/callers: App.tsx. API: AUTH.login only.
import { useState } from 'react';
import { AUTH } from '../api/client';
import { IconKey } from '../components/Icons';
import { CardNeon } from '../components/CardNeon';

export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setErr('Username wajib diisi'); return; }
    if (!password) { setErr('Password wajib diisi'); return; }
    setBusy(true);
    setErr('');
    try {
      const res = await AUTH.login(username.trim(), password);
      localStorage.setItem('trading_token', res.token);
      onLogin(res.username);
    } catch (ex: any) {
      setErr(ex.message ?? 'Login gagal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <CardNeon style={{ width: '100%', maxWidth: 400, padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span className="dot" style={{ width: 12, height: 12, background: 'var(--accent)', boxShadow: '0 0 16px var(--accent-glow)' }} />
          <h1 style={{ margin: 0, fontSize: 22, fontFamily: 'var(--font-heading)' }}>DEX Trade</h1>
        </div>
        <p style={{ color: 'var(--muted)', margin: '0 0 20px' }}>
          Paper trading virtual — login untuk melanjutkan progress Anda.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            USERNAME
            <input className="input" style={{ width: '100%' }} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, position: 'relative' }}>
            PASSWORD
            <input
              type={showPw ? 'text' : 'password'}
              className="input"
              style={{ width: '100%', paddingRight: 44 }}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button type="button" aria-label={showPw ? 'Sembunyikan password' : 'Tampilkan password'} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, lineHeight: 1, display: 'grid', placeItems: 'center' }} onClick={() => setShowPw(!showPw)}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {showPw
                  ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></>
                  : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
              </svg>
            </button>
          </label>

          {err && <div className="error" style={{ margin: 0 }}><IconKey size={14} /> {err}</div>}

          <button type="submit" className="btn primary" style={{ minHeight: 46, width: '100%', fontWeight: 700 }} disabled={busy}>
            {busy ? 'Melogin…' : 'Login'}
          </button>
        </form>

        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16, textAlign: 'center', lineHeight: 1.5 }}>
          Registrasi dinonaktifkan — tambah akun lewat <code>USER_USERNAME</code>/<code>USER_PASSWORD</code> di
          <code> backend/.env</code>, lalu restart backend.
        </p>
      </CardNeon>
    </div>
  );
}