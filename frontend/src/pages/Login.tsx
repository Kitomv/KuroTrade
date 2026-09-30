// Login page — two independent ways in: sign with a wallet, or use the
// username/password seeded from the backend env. Importers/callers: App.tsx.
// API: AUTH.login, AUTH.loginWalletChallenge, AUTH.loginWallet.
//
// The wallet path talks to window.ethereum directly through lib/evm.ts, which
// is context-free — so this page needs no EvmWalletProvider (that one is
// mounted only after login and is not available here).
import { useState } from 'react';
import { AUTH } from '../api/client';
import { hasInjectedWallet, requestAccounts, personalSign } from '../lib/evm';
import { IconKey } from '../components/Icons';
import { CardNeon } from '../components/CardNeon';

export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState<'password' | 'wallet' | null>(null);
  const [err, setErr] = useState('');
  const walletAvailable = hasInjectedWallet();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setErr('Username wajib diisi'); return; }
    if (!password) { setErr('Password wajib diisi'); return; }
    setBusy('password');
    setErr('');
    try {
      const res = await AUTH.login(username.trim(), password);
      localStorage.setItem('trading_token', res.token);
      // Password login always has a username; the null branch is wallet-only.
      onLogin(res.username ?? username.trim());
    } catch (ex: any) {
      setErr(ex.message ?? 'Login gagal');
    } finally {
      setBusy(null);
    }
  };

  const handleWalletLogin = async () => {
    setBusy('wallet');
    setErr('');
    try {
      const accounts = await requestAccounts();
      const address = accounts[0];
      if (!address) { setErr('Tidak ada akun di MetaMask'); return; }

      const { message } = await AUTH.loginWalletChallenge(address);
      const signature = await personalSign(message, address);
      const res = await AUTH.loginWallet(address, signature);

      localStorage.setItem('trading_token', res.token);
      // A wallet-only account has no username; show the short address instead
      // so the sidebar still has something to render.
      onLogin(res.username ?? `${res.address.slice(0, 6)}…${res.address.slice(-4)}`);
    } catch (ex: any) {
      // MetaMask rejections arrive as opaque provider errors ("User rejected
      // the request"), so translate the common one rather than showing it raw.
      const raw = String(ex?.message ?? '');
      setErr(
        /user rejected|user denied|rejected the request/i.test(raw)
          ? 'Signature dibatalkan di MetaMask'
          : raw || 'Login wallet gagal',
      );
    } finally {
      setBusy(null);
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

          <button type="submit" className="btn primary" style={{ minHeight: 46, width: '100%', fontWeight: 700 }} disabled={busy !== null}>
            {busy === 'password' ? 'Melogin…' : 'Login'}
          </button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>atau</span>
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <button
          type="button"
          className="btn"
          style={{ minHeight: 46, width: '100%', fontWeight: 700 }}
          disabled={busy !== null || !walletAvailable}
          onClick={handleWalletLogin}
          title={walletAvailable ? 'Tanda tangan satu pesan untuk masuk' : 'Ekstensi MetaMask tidak terdeteksi'}
        >
          {busy === 'wallet' ? 'Menunggu MetaMask…' : 'Login dengan MetaMask'}
        </button>
        {!walletAvailable && (
          <p style={{ color: 'var(--down)', fontSize: 11, marginTop: 8, textAlign: 'center' }}>
            MetaMask tidak terdeteksi — install ekstensinya untuk memakai cara ini.
          </p>
        )}

        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16, textAlign: 'center', lineHeight: 1.5 }}>
          Login wallet membuat akun otomatis bila wallet-nya belum pernah dipakai. Akun berbasis password
          tetap ditambah lewat <code>USER_USERNAME</code>/<code>USER_PASSWORD</code> di <code>backend/.env</code>.
        </p>
      </CardNeon>
    </div>
  );
}