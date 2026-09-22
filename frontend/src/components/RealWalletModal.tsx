// Modal UI for the global Real Wallet control. The engine lives in
// RealWalletContext (always mounted), so this view only presents state +
// approvals and survives Portfolio no longer hosting the real UI.
// Importers/callers: RealWalletControl (lazy). User: "yang di porto hilangin real walletnya".
import { Modal } from './Modal';
import { RealTradePanel, PendingIntents } from './RealTradePanel';
import { RealWalletBalance } from './RealWalletBalance';
import { WalletButton } from './WalletButton';
import { useRealWallet } from './RealWalletContext';
import { IconAlert } from './Icons';

export default function RealWalletModal({ onClose }: { onClose: () => void }) {
  const { connected, isBound, realMode, realAuto, binding, bindError, setRealMode, setRealAuto, bindWallet, openIntents } = useRealWallet();

  const toggleAuto = async () => {
    if (!realAuto && !confirm('Nyalakan AUTO-EXECUTE real? Semua intent langsung meminta tanda tangan Phantom tanpa klik approve. Tidak ada batas USD.')) return;
    await setRealAuto(!realAuto);
  };

  return (
    <Modal title="Real Wallet Mode" onClose={onClose} maxWidth={680}>
      <div className="rwc-row" style={{ marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>{realMode ? (realAuto ? 'REAL · AUTO-EXECUTE' : 'REAL · MANUAL') : 'VIRTUAL'}</strong>
        <WalletButton compact />
      </div>
      <div className="rwc-row">
        <span className="rwc-k">Mode real</span>
        <button className={`btn${realMode ? ' primary' : ''}`} style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }} disabled={!connected || !isBound} onClick={() => setRealMode(!realMode)}>
          {realMode ? 'ON' : 'OFF'}
        </button>
      </div>
      {connected && !isBound && (
        <div className="rwc-row">
          <span className="rwc-k">Bind wallet</span>
          <button className="btn primary" style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }} disabled={binding} onClick={() => bindWallet()}>
            {binding ? 'Menunggu…' : 'Bind Wallet'}
          </button>
        </div>
      )}
      {bindError && <div className="rwc-error"><IconAlert size={13} /> {bindError}</div>}
      {realMode && connected && isBound && (
        <div className="rwc-row">
          <span className="rwc-k">Auto-execute</span>
          <button className="btn" style={{ minHeight: 32, padding: '4px 14px', fontSize: 12, background: realAuto ? 'rgba(239,68,68,.18)' : 'transparent', color: realAuto ? 'var(--down)' : 'var(--muted)' }} onClick={toggleAuto}>
            {realAuto ? 'ON' : 'OFF'}
          </button>
        </div>
      )}
      {connected && <div style={{ marginTop: 12 }}><RealWalletBalance /></div>}
      {connected && openIntents.length > 0 && <div style={{ marginTop: 12 }}><PendingIntents compact /></div>}
      {connected && realMode && isBound && <div style={{ marginTop: 12 }}><RealTradePanel /></div>}
      {!connected && <p className="rwc-hint" style={{ marginTop: 10 }}>Connect Phantom untuk memakai mode real. Private key tetap di wallet.</p>}
    </Modal>
  );
}