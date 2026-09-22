// Sidebar account area now includes a global Real Wallet control above the user.
// Importers/callers: App.tsx. API/data: RealWalletControl consumes the shared
// RealWalletContext; no sidebar-owned wallet state. User: "taruh di atas akun".
import { useState } from 'react';
import { Page as NavPage } from '../api/client';
import { Modal } from './Modal';
import { RealWalletControl } from './RealWalletControl';

type Page = NavPage;

const nav: { page: Page; label: string; icon: JSX.Element; secondary?: boolean }[] = [
  {
    page: 'overview',
    label: 'Overview',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    page: 'trending',
    label: 'Trending',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M23 6l-9.5 9.5-5-5L1 18" />
        <path d="M17 6h6v6" />
      </svg>
    ),
  },
  {
    page: 'watchlist',
    label: 'Watchlist',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    page: 'chart',
    label: 'Chart',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
  {
    page: 'trade',
    label: 'Trade',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M7 16V4M7 4L3 8M7 4L11 8" />
        <path d="M17 8v12M17 20l4-4M17 20l-4-4" />
      </svg>
    ),
  },
  {
    page: 'portfolio',
    label: 'Portfolio',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
        <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
      </svg>
    ),
  },
  {
    page: 'agents',
    label: 'AI Agents',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4 4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" />
        <path d="M8 12v3a4 4 0 0 0 8 0v-3" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="8" y1="22" x2="16" y2="22" />
      </svg>
    ),
    secondary: true,
  },
  {
    page: 'leaderboard',
    label: 'Leaderboard',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 21h8M12 17v4" />
        <path d="M17 4h3a1 1 0 0 1 1 1v2a4 4 0 0 1-4 4h-.5" />
        <path d="M7 4H4a1 1 0 0 0-1 1v2a4 4 0 0 0 4 4h.5" />
        <path d="M7 2h10v7a5 5 0 0 1-10 0z" />
      </svg>
    ),
    secondary: true,
  },
];

export function Sidebar({ page, onNavigate, username, onLogout, onChangePassword }: {
  page: Page;
  onNavigate: (p: Page) => void;
  username?: string;
  onLogout?: () => void;
  onChangePassword?: (current: string, next: string) => Promise<void>;
}) {
  const [showPw, setShowPw] = useState(false);
  const [showMore, setShowMore] = useState(false);
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
    } catch (ex: any) {
      setPwErr(ex.message ?? 'Gagal ganti password');
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <span className="dot" />
        <span>DEX Trade</span>
      </div>
      {nav.map(({ page: p, label, icon, secondary }) => (
        <button
          key={p}
          className={`nav-item${p === page ? ' active' : ''}${secondary ? ' nav-secondary' : ''}`}
          onClick={() => onNavigate(p)}
          aria-current={p === page ? 'page' : undefined}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
      {username && (
        <>
          <RealWalletControl />
          <div className="sidebar-user">
            <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span className="dot" style={{ width: 8, height: 8, marginRight: 6 }} />{username}
            </div>
            <button className="btn" style={{ width: '100%', minHeight: 34, padding: '4px 8px', fontSize: 12, marginBottom: 6 }} onClick={() => setShowPw(true)}>
              Ganti Password
            </button>
            <button className="btn" style={{ width: '100%', minHeight: 34, padding: '4px 8px', fontSize: 12 }} onClick={onLogout}>
              Logout
            </button>
          </div>
        </>
      )}
      {username && (
        <button type="button" className="nav-item nav-more-btn" onClick={() => setShowMore(true)} aria-label="Menu lainnya" aria-haspopup="dialog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
          <span>Lainnya</span>
        </button>
      )}

      {showMore && (
        <Modal title="Menu Lainnya" onClose={() => setShowMore(false)} maxWidth={360}>
          <div className="nav-more-list">
            {nav.map(({ page: p, label, icon }) => (
              <button
                key={p}
                type="button"
                className={`nav-more-item${p === page ? ' active' : ''}`}
                onClick={() => { setShowMore(false); onNavigate(p); }}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
            <button type="button" className="nav-more-item" onClick={() => { setShowMore(false); setShowPw(true); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m2 2l2-2" />
              </svg>
              <span>Ganti Password</span>
            </button>
            <button type="button" className="nav-more-item" style={{ color: 'var(--down)', borderColor: 'rgba(239,68,68,.4)' }} onClick={() => { setShowMore(false); onLogout?.(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
              <span>Logout{username ? ` (${username})` : ''}</span>
            </button>
          </div>
        </Modal>
      )}

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
    </nav>
  );
}