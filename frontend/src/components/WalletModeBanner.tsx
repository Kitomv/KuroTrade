// Global REAL-Wallet banner. When real mode is on, every page operates against
// the bound MetaMask address, so this bar sits at the top of <main> as an
// always-visible mode indicator plus a one-click switch back to VIRTUAL.
// Importers/callers: App.tsx. API: useEvmWallet().
// Data schema: none (presentational).
import { useEvmWallet } from './EvmWalletContext';
import { IconWallet, IconArrowDown } from './Icons';

export function WalletModeBanner() {
  const { loaded, connected, isBound, realMode, setRealMode } = useEvmWallet();
  if (!loaded || !realMode) return null;

  return (
    <div className="mode-banner" role="status">
      <span className="mode-banner-dot" aria-hidden="true" />
      <span className="mode-banner-text">
        <IconWallet size={13} />
        <strong>REAL WALLET AKTIF</strong>
        <span className="mode-banner-sep" aria-hidden="true">·</span>
        {!connected
          ? 'Connect MetaMask untuk eksekusi dana asli'
          : !isBound
            ? 'Bind wallet di panel Real Wallet dulu'
            : 'Dana asli — setiap transaksi di-approve di MetaMask'}
      </span>
      <button type="button" className="mode-banner-btn" onClick={() => setRealMode(false)} aria-label="Kembali ke virtual wallet">
        <IconArrowDown size={13} />
        Virtual Wallet
      </button>
    </div>
  );
}
