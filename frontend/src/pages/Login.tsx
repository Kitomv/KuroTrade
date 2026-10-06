// Login page — two independent ways in: sign with a wallet, or use the
// username/password seeded from the backend env. Importers/callers: App.tsx.
// API: AUTH.login, AUTH.loginWalletChallenge, AUTH.loginWallet.
//
// The wallet path talks to window.ethereum directly through lib/evm.ts, which
// is context-free — so this page needs no EvmWalletProvider (that one is
// mounted only after login and is not available here).
//
// Layout is an identity rail beside the entry frame rather than a centred
// card: the rail carries the one thing a real-money user needs before typing
// anything — the server never holds a key.
import { useEffect, useState } from 'react';
import { AUTH } from '../api/client';
import { hasInjectedWallet, requestAccounts, personalSign, subscribeProviders } from '../lib/evm';
import { vaultLabel, walletLabel, rejectionMessage, type PendingAuth } from '../lib/loginView';
import { IconAlert, IconTrendingUp } from '../components/Icons';

export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState<PendingAuth | null>(null);
  const [err, setErr] = useState('');
  // Re-check on announce: the extension can be installed or enabled after this
  // page mounted, and a button stuck on "not detected" until a reload is a
  // dead end for the user.
  const [walletAvailable, setWalletAvailable] = useState(() => hasInjectedWallet());
  useEffect(() => subscribeProviders(() => setWalletAvailable(hasInjectedWallet())), []);

  const busy = pending !== null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setErr('Username wajib diisi'); return; }
    if (!password) { setErr('Password wajib diisi'); return; }
    setPending({ kind: 'password', step: 'login' });
    setErr('');
    try {
      const res = await AUTH.login(username.trim(), password);
      localStorage.setItem('trading_token', res.token);
      // Password login always has a username; the null branch is wallet-only.
      onLogin(res.username ?? username.trim());
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Login gagal');
    } finally {
      setPending(null);
    }
  };

  const handleWalletLogin = async () => {
    setPending({ kind: 'wallet', step: 'connect' });
    setErr('');
    try {
      const accounts = await requestAccounts();
      const address = accounts[0];
      if (!address) { setErr('Tidak ada akun di MetaMask'); return; }

      const { message } = await AUTH.loginWalletChallenge(address);
      setPending({ kind: 'wallet', step: 'sign' });
      const signature = await personalSign(message, address);

      setPending({ kind: 'wallet', step: 'verify' });
      const res = await AUTH.loginWallet(address, signature);

      localStorage.setItem('trading_token', res.token);
      // A wallet-only account has no username; show the short address instead
      // so the sidebar still has something to render.
      onLogin(res.username ?? `${res.address.slice(0, 6)}…${res.address.slice(-4)}`);
    } catch (ex: unknown) {
      setErr(rejectionMessage(ex));
    } finally {
      setPending(null);
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
              {pending?.kind === 'password' && <span className="spinner" aria-hidden="true" />}
              {vaultLabel(pending)}
            </button>
          </form>

          <div className="login-or" aria-hidden="true"><span>atau</span></div>

          <button
            type="button"
            className="btn login-wallet"
            disabled={busy || !walletAvailable}
            onClick={handleWalletLogin}
            title={walletAvailable ? 'Tanda tangan satu pesan untuk masuk' : 'Ekstensi MetaMask tidak terdeteksi'}
          >
            {pending?.kind === 'wallet' && <span className="spinner" aria-hidden="true" />}
            {walletLabel(pending)}
          </button>

          {!walletAvailable && (
            <p className="login-wallet-missing">
              MetaMask tidak terdeteksi — install ekstensinya untuk memakai cara ini.
            </p>
          )}

          <p className="login-foot">
            Login wallet membuat akun otomatis untuk wallet baru. Akun berbasis password
            ditambah lewat <code>USER_USERNAME</code>/<code>USER_PASSWORD</code> di <code>backend/.env</code>.
          </p>
        </section>
      </div>
    </div>
  );
}
