// Real-Wallet mode control — a login-style entry placed above the account block.
// Shows connection/bind state and exposes Connect, Bind, and Real/Virtual +
// Auto-Approve toggles. Reads shared state via useRealWallet() so Portfolio and
// this control always agree. Importer: Sidebar.tsx.
// User instruction: "mending buatin mode real wallet sendiri jadi kayak login gitu, taruh di atas akun".
import React, { Suspense, useState } from 'react';
import { useRealWallet } from './RealWalletContext';

const RealWalletModal = React.lazy(() => import('./RealWalletModal'));
import { useConfirm } from './ConfirmDialog';
import { WalletButton } from './WalletButton';
import { IconWallet, IconLock, IconAlert } from './Icons';
import { PendingIntents } from './RealTradePanel';

function statusOf({ connected, isBound, realMode, realAuto }: { connected: boolean; isBound: boolean; realMode: boolean; realAuto: boolean }) {
  if (!connected) return { label: 'Belum terhubung', tone: 'muted' as const };
  if (!isBound) return { label: 'Perlu bind wallet', tone: 'warn' as const };
  if (!realMode) return { label: 'Mode virtual', tone: 'muted' as const };
  return realAuto ? { label: 'REAL · auto-execute', tone: 'danger' as const } : { label: 'REAL · manual approve', tone: 'ok' as const };
}

export function RealWalletControl() {
  const { connected, isBound, realMode, realAuto, loaded, binding, bindError, setRealMode, setRealAuto, bindWallet, openIntents } = useRealWallet();
  const confirmAction = useConfirm();
  const [open, setOpen] = useState(false);
  const [openFull, setOpenFull] = useState(false);
  const st = statusOf({ connected, isBound, realMode, realAuto });

  const toggleAuto = async () => {
    if (realAuto) { await setRealAuto(false); return; }
    const ok = await confirmAction({
      title: 'Nyalakan Auto-Execute Real?',
      message: 'Semua BUY/SELL autopilot langsung menjalankan swap TANPA klik Approve. Tidak ada batas USD. Phantom tetap popup tiap transaksi — Reject = intent di-skip.',
      confirmLabel: 'Ya, auto-execution',
      danger: true,
    });
    if (ok) await setRealAuto(true);
  };

  return (
    <div className="real-wallet-control">
      <button type="button" className="rwc-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={!loaded}>
        <span className="rwc-icon" aria-hidden="true"><IconWallet size={15} /></span>
        <span className="rwc-title">Real Wallet</span>
        <span className={`rwc-status ${st.tone}`}>{connected ? st.label : 'Connect'}</span>
        <svg className={`rwc-chev${open ? ' up' : ''}`} viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="rwc-panel card">
          <div className="rwc-row"><span className="rwc-k">Wallet</span><WalletButton compact /></div>
          {connected && (
            <div className="rwc-row">
              <span className="rwc-k">Bind</span>
              {isBound ? <span className="rwc-badge ok"><IconLock size={12} /> Ter-bind</span> : <button type="button" className="btn primary" style={{ minHeight: 32, padding: '4px 12px', fontSize: 12 }} disabled={binding} onClick={() => bindWallet()}>{binding ? 'Menunggu…' : 'Bind Wallet'}</button>}
            </div>
          )}
          {bindError && <div className="rwc-error"><IconAlert size={13} /> {bindError}</div>}
          <div className="rwc-row">
            <span className="rwc-k">Mode</span>
            <label className="rwc-switch">
              <input type="checkbox" checked={realMode} disabled={!connected || !isBound || !loaded} onChange={(e) => setRealMode(e.target.checked)} />
              <span className="rwc-switch-track"><span className="rwc-switch-thumb" /></span>
              <span className="rwc-switch-label">{realMode ? 'Real' : 'Virtual'}</span>
            </label>
          </div>
          {realMode && (
            <div className="rwc-row">
              <span className="rwc-k">Approve</span>
              <label className="rwc-switch">
                <input type="checkbox" checked={realAuto} onChange={(e) => { e.target.checked ? toggleAuto() : setRealAuto(false); }} />
                <span className="rwc-switch-track danger"><span className="rwc-switch-thumb" /></span>
                <span className="rwc-switch-label">{realAuto ? 'Auto-execute' : 'Manual'}</span>
              </label>
            </div>
          )}
          {realMode && connected && openIntents.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <PendingIntents compact />
            </div>
          )}
          <p className="rwc-hint">{connected && !isBound ? 'Bind wallet sekali agar swap dana asli diizinkan.' : !connected ? 'Connect Phantom untuk mengaktifkan mode real.' : realAuto ? '⚠ Dana asli bergerak otomatis; Phantom tetap sign tiap tx.' : 'Intent autopilot perlu kamu approve manual.'}</p>
          <button type="button" className="rwc-full" onClick={() => setOpenFull(true)}>Buka Panel Trading →</button>
        </div>
      )}
      {openFull && (
        <Suspense fallback={null}>
          <RealWalletModal onClose={() => setOpenFull(false)} />
        </Suspense>
      )}
    </div>
  );
}
