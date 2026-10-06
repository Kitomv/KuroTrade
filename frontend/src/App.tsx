// App shell: nav, auth gate, page router, shared providers (Toast, Confirm).
// Importers/callers: main.tsx. API: none (root component).
// User instruction: "side bar buat bisa di hide" — collapsible sidebar, persisted in localStorage.
// Desktop only; mobile bottom nav unchanged.
import { useState, useCallback, useEffect } from 'react';
import { Page, Market, AUTH, UserRole } from './api/client';
import { Sidebar } from './components/Sidebar';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Trending } from './pages/Trending';
import { Watchlist } from './pages/Watchlist';
import { Chart } from './pages/Chart';
import { Trade } from './pages/Trade';
import { Portfolio } from './pages/Portfolio';
import { Agents } from './pages/Agents';
import { Leaderboard } from './pages/Leaderboard';
import { Settings } from './pages/Settings';
import { Admin } from './pages/Admin';
import { ToastProvider } from './components/ToastProvider';
import { ConfirmProvider } from './components/ConfirmDialog';
import { WalletModeBanner } from './components/WalletModeBanner';
import { EvmWalletProvider } from './components/EvmWalletContext';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(localStorage.getItem('trading_token')));
  const [username, setUsername] = useState(() => localStorage.getItem('trading_username') ?? '');
  // 'user' until /api/me says otherwise: an unknown or absent role must never
  // reveal the Admin page, matching the server's fail-closed roleOf().
  const [role, setRole] = useState<UserRole>('user');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState<Page>('overview');
  const [watchKey, setWatchKey] = useState(0);
  const [tradePrefill, setTradePrefill] = useState<{ market: Market; nonce: number } | null>(null);
  // Desktop sidebar collapse (persisted; mobile bottom bar unaffected).
  const [navOpen, setNavOpen] = useState<boolean>(() => localStorage.getItem('trading_nav_open') !== '0');

  // 401 anywhere → drop token, back to login. The role resets with it so the
  // next sign-in cannot briefly inherit the previous session's Admin entry
  // while /api/me is still in flight.
  useEffect(() => {
    const on401 = () => {
      setRole('user');
      setUserId('');
      setPage('overview');
      setAuthed(false);
    };
    addEventListener('trading-unauthorized', on401);
    return () => removeEventListener('trading-unauthorized', on401);
  }, []);

  // Refresh profile (username + role) when authenticated — also validates the
  // stored token on boot.
  //
  // The role is re-read from the server on every load rather than cached: a
  // demoted admin loses the Admin page on the next refresh instead of keeping
  // it for the life of the session. It is deliberately NOT persisted, so a
  // stale localStorage value can never unlock the page.
  //
  // A wallet-only account has no username (the address IS the identity), so
  // /api/me returns ''. Falling through with '' would drop `username` to
  // falsy and the Sidebar renders its account block — including the Real
  // Wallet control — only when a username is present. The address is the
  // natural label, and without it the wallet panel becomes unreachable after
  // a refresh.
  useEffect(() => {
    if (!authed) return;
    AUTH.me()
      .then((me) => {
        const label = me.username || (me.address ? `${me.address.slice(0, 6)}…${me.address.slice(-4)}` : '');
        setUsername(label);
        setRole(me.role);
        setUserId(me.userId);
        localStorage.setItem('trading_username', label);
      })
      .catch(() => {});
  }, [authed]);

  const refreshWatchlist = useCallback(() => setWatchKey((k) => k + 1), []);

  const handleLogout = async () => {
    try { await AUTH.logout(); } catch {}
    localStorage.removeItem('trading_token');
    localStorage.removeItem('trading_username');
    // Drop the role too: the next person to log in on this browser must not
    // inherit the previous session's Admin entry, even for one render.
    setRole('user');
    setUserId('');
    setPage('overview');
    setAuthed(false);
  };

  const navTo = useCallback((p: Page, market?: Market) => {
    // Fail closed: nothing that is not an admin may land on the Admin page,
    // whatever asked for it. The render gate is the real backstop; this keeps
    // the page from even mounting.
    if (p === 'admin' && role !== 'admin') return;
    if (p === 'trade' && market) {
      setTradePrefill({ market, nonce: Date.now() });
    } else if (p !== 'trade') {
      setTradePrefill(null); // side-nav away clears the preset → no stale refill
    }
    setPage(p);
  }, [role]);

  // Early return AFTER all hooks — returning before a hook would change the
  // hook count between renders and crash React on login.
  return (
    <ToastProvider>
      <ConfirmProvider>
        {!authed
          ? <Login onLogin={(u) => { setUsername(u); localStorage.setItem('trading_username', u); setAuthed(true); }} />
          : (
            <EvmWalletProvider>
                <div className={`shell${navOpen ? '' : ' nav-collapsed'}`}>
                  <Sidebar
                    page={page}
                    onNavigate={navTo}
                    username={authed ? username : undefined}
                    role={role}
                  />
                  <main className="main">
                    <WalletModeBanner />
                    {/* Desktop-only collapse toggle; sits above page content. */}
                    <button
                      type="button"
                      className="nav-toggle"
                      aria-label={navOpen ? 'Sembunyikan sidebar' : 'Tampilkan sidebar'}
                      aria-expanded={navOpen}
                      title={navOpen ? 'Sembunyikan sidebar' : 'Tampilkan sidebar'}
                      onClick={() => {
                        setNavOpen((open) => {
                          const next = !open;
                          localStorage.setItem('trading_nav_open', next ? '1' : '0');
                          return next;
                        });
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18M3 12h18M3 18h18" />
                      </svg>
                    </button>
                    {page === 'overview' && <Overview refreshWatchlist={refreshWatchlist} onNavigateTab={navTo} />}
                    {page === 'trending' && <Trending />}
                    {page === 'watchlist' && <Watchlist key={watchKey} onUpdated={refreshWatchlist} />}
                    {page === 'chart' && <Chart />}
                    {page === 'trade' && <Trade prefill={tradePrefill} />}
                    {page === 'portfolio' && <Portfolio />}
                    {page === 'agents' && <Agents onNavigate={navTo} />}
                    {page === 'leaderboard' && <Leaderboard />}
                    {page === 'settings' && <Settings username={username} onChangePassword={async (cur, next) => { await AUTH.changePassword(cur, next); }} onLogout={handleLogout} />}
                    {/* Role-gated here too, not only in the nav: a stale hash,
                        a hand-typed page value, or a demotion mid-session must
                        not render the page. The API refuses it regardless. */}
                    {page === 'admin' && role === 'admin' && <Admin currentUserId={userId} />}
                  </main>
                </div>
            </EvmWalletProvider>
          )
        }
      </ConfirmProvider>
    </ToastProvider>
  );
}