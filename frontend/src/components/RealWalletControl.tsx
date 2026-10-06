// Real-Wallet mode control — a login-style entry placed above the account block.
// Shows connection/bind/mode state at a glance; clicking it opens the CENTERED
// RealWalletModal (previously an inline dropdown anchored to the sidebar, which
// felt cramped and clipped on narrow screens).
// Importers/callers: Sidebar.tsx. API: useEvmWallet() shared context.
// User instruction: "kenapa pas real wallet mode pas buka panel kok masih di side
// bar" → move the panel to a centered modal.
import React, { Suspense, useState } from 'react';
import { useEvmWallet } from './EvmWalletContext';
import { IconWallet } from './Icons';

const RealWalletModal = React.lazy(() => import('./RealWalletModal'));

function statusOf({ connected, isBound, realMode, autoApprove }: { connected: boolean; isBound: boolean; realMode: boolean; autoApprove: boolean }) {
  if (!connected) return { label: 'Belum terhubung', tone: 'muted' as const };
  if (!isBound) return { label: 'Perlu bind wallet', tone: 'warn' as const };
  if (!realMode) return { label: 'Mode virtual', tone: 'muted' as const };
  // The who-signs distinction belongs on the always-visible chip, not only in
  // the modal: it decides whether a trade needs the user at all.
  return autoApprove
    ? { label: 'REAL · auto-buka MetaMask', tone: 'danger' as const }
    : { label: 'REAL · approve manual', tone: 'danger' as const };
}

export function RealWalletControl() {
  const { connected, isBound, realMode, autoApprove, loaded } = useEvmWallet();
  const [open, setOpen] = useState(false);
  const st = statusOf({ connected, isBound, realMode, autoApprove });

  return (
    <div className="real-wallet-control">
      <button
        type="button"
        className="rwc-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        disabled={!loaded}
        title="Buka panel Real Wallet"
      >
        <span className="rwc-icon" aria-hidden="true"><IconWallet size={15} /></span>
        <span className="rwc-title">Real Wallet</span>
        <span className={`rwc-status ${st.tone}`}>{connected ? st.label : 'Connect'}</span>
      </button>

      {open && (
        <Suspense fallback={null}>
          <RealWalletModal onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
