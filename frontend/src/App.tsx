// App shell: nav, auth gate, page router, shared providers (Toast, Confirm).
// Importers/callers: main.tsx. API: none (root component).
// User instruction: "side bar buat bisa di hide" — collapsible sidebar, persisted in localStorage.
// Desktop only; mobile bottom nav unchanged.
import { useState, useCallback, useEffect } from 'react';
import { Page, Market, AUTH } from './api/client';
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
import { ToastProvider } from './components/ToastProvider';
import { ConfirmProvider } from './components/ConfirmDialog';
import { WalletModeBanner } from './components/WalletModeBanner';
import React, { Suspense, lazy } from 'react';

// Lazy so the ~590KB wallet+solana vendor chunks never load on the login screen.
// Mounted once around the authed shell (not inside Portfolio) so navigating
// between pages keeps the Phantom connection alive.
const WalletProviderGate = lazy(() => import('./components/WalletProviderGate'));

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(localStorage.getItem('trading_token')));
  const [username, setUsername] = useState(() => localStorage.getItem('trading_username') ?? '');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [page, setPage] = useState<Page>('overview');
  const [watchKey, setWatchKey] = useState(0);
  const [tradePrefill, setTradePrefill] = useState<{ market: Market; nonce: number } | null>(null);
  // Desktop sidebar collapse (persisted; mobile bottom bar unaffected).
  const [navOpen, setNavOpen] = useState<boolean>(() => localStorage.getItem('trading_nav_open') !== '0');

  // 401 anywhere → drop token, back to login.
  useEffect(() => {
    const on401 = () => setAuthed(false);
    addEventListener('trading-unauthorized', on401);
    return () => removeEventListener('trading-unauthorized', on401);
  }, []);

  // Refresh profile (username + role) when authenticated — also validates the
  // stored token on boot.
  useEffect(() => {
    if (!authed) return;
    AUTH.me()
      .then((me) => {
        setUsername(me.username);
        setRole(me.role);
        localStorage.setItem('trading_username', me.username);
      })
      .catch(() => {});
  }, [authed]);

  const refreshWatchlist = useCallback(() => setWatchKey((k) => k + 1), []);

  const handleLogout = async () => {
    try { await AUTH.logout(); } catch {}
    localStorage.removeItem('trading_token');
    localStorage.removeItem('trading_username');
    setAuthed(false);
  };

  const navTo = useCallback((p: Page, market?: Market) => {
    if (p === 'trade' && market) {
      setTradePrefill({ market, nonce: Date.now() });
    } else if (p !== 'trade') {
      setTradePrefill(null); // side-nav away clears the preset → no stale refill
    }
    setPage(p);
  }, []);

  // Early return AFTER all hooks — returning before a hook would change the
  // hook count between renders and crash React on login.
  return (
    <ToastProvider>
      <ConfirmProvider>
        {!authed
          ? <Login onLogin={(u) => { setUsername(u); localStorage.setItem('trading_username', u); setAuthed(true); }} />
          : (
            <Suspense fallback={null}>
              <WalletProviderGate>
                <div className={`shell${navOpen ? '' : ' nav-collapsed'}`}>
                  <Sidebar
                    page={page}
                    onNavigate={navTo}
                    username={authed ? username : undefined}
                    onLogout={handleLogout}
                    onChangePassword={async (cur, next) => { await AUTH.changePassword(cur, next); }}
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
                    {page === 'agents' && <Agents />}
                    {page === 'leaderboard' && <Leaderboard role={role} />}
                  </main>
                </div>
              </WalletProviderGate>
            </Suspense>
          )
        }
      </ConfirmProvider>
    </ToastProvider>
  );
}