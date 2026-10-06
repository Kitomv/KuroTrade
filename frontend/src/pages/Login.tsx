// Login page — one way in: a username and password issued by an admin.
// Importers/callers: App.tsx. API: AUTH.login.
//
// There is deliberately no self-registration and no wallet login. Access is
// granted by an admin, so a wallet that has never been issued an account
// cannot mint one by signing a message. Wallet signing still happens — but
// later, to trade real funds (see lib/evm.ts and EvmWalletContext), never to
// become a user.
//
// Layout is an identity rail beside the entry frame rather than a centred
// card: the rail carries the one thing a real-money user needs before typing
// anything — the server never holds a key.
import { useState } from 'react';
import { AUTH } from '../api/client';
import { vaultLabel, credentialError } from '../lib/loginView';
import { IconAlert, IconTrendingUp } from '../components/Icons';

export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = credentialError(username, password);
    if (invalid) { setErr(invalid); return; }
    setBusy(true);
    setErr('');
    try {
      const res = await AUTH.login(username.trim(), password);
      localStorage.setItem('trading_token', res.token);
      onLogin(res.username || username.trim());
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Login gagal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-halo" aria-hidden="true" />

      <div className="login-inner">
        <section className="login-rail" aria-label="Tentang DEX Trade">
          <div className="login-brand">
            <IconTrendingUp size={18} />
            <span>DEX Trade</span>
          </div>
          <p className="login-rail-lead">Paper trading desk dengan jalur dana asli.</p>
          <div className="login-rail-note">
            <strong>Server tidak menyimpan private key.</strong>
            <span>
              Transaksi dana asli dibangun di sini, lalu ditandatangani di MetaMask Anda —
              setiap kali, tanpa kecuali.
            </span>
          </div>
        </section>

        <section className="login-frame" aria-labelledby="login-title">
          <header className="login-head">
            <h1 id="login-title">Masuk</h1>
            <p>Lanjutkan sesi trading Anda.</p>
          </header>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="login-username">Username</label>
              <input
                id="login-username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>

            <div className="login-field">
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type={showPw ? 'text' : 'password'}
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="login-eye"
                aria-label={showPw ? 'Sembunyikan password' : 'Tampilkan password'}
                aria-pressed={showPw}
                onClick={() => setShowPw(!showPw)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {showPw
                    ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></>
                    : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
                </svg>
              </button>
            </div>

            {err && (
              <p className="login-error" role="alert">
                <IconAlert size={14} />
                {err}
              </p>
            )}

            <button type="submit" className="btn primary login-submit" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {vaultLabel(busy)}
            </button>
          </form>

          <p className="login-foot">
            Belum punya akun? Akun dibuat oleh admin — hubungi admin untuk
            mendapatkan akses.
          </p>
        </section>
      </div>
    </div>
  );
}
