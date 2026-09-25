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
  {
    page: 'settings',
    label: 'Pengaturan',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    secondary: true,
  },
];

export function Sidebar({ page, onNavigate, username }: {
  page: Page;
  onNavigate: (p: Page) => void;
  username?: string;
}) {
  // Change Password + Logout moved to the Pengaturan page (fewer mis-clicks).
  const [showMore, setShowMore] = useState(false);

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
            <button className="btn" style={{ width: '100%', minHeight: 34, padding: '4px 8px', fontSize: 12 }} onClick={() => onNavigate('settings')}>
              Akun &amp; Pengaturan
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
          </div>
        </Modal>
      )}
    </nav>
  );
}