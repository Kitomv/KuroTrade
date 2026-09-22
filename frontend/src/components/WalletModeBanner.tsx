// Global REAL-Wallet banner. When real mode is on, every page (Dashboard →
// Leaderboard) operates against the real wallet, so this bar sits at the top of
// <main> as an always-visible mode indicator + a one-click switch back to
// VIRTUAL. Reads state from useRealWallet() (context mounted once at App level,
// so it survives page navigation).
// Importers/callers: App.tsx (inside WalletProviderGate).
// API: useRealWallet() — existing context, no new endpoints.
// Data schema: none (presentational).
// User instruction: "pilih real wallet all jadi real wallet apapun itu dari
// dashboard sampai leaderboard, terus ada tombol virtual wallet".
import { useRealWallet } from './RealWalletContext';
import { IconWallet, IconArrowDown } from './Icons';

export function WalletModeBanner() {
  const { loaded, connected, isBound, realMode, realAuto, setRealMode } = useRealWallet();
  if (!loaded || !realMode) return null;

  return (
    <div className="mode-banner" role="status">
      <span className="mode-banner-dot" aria-hidden="true" />
      <span className="mode-banner-text">
        <IconWallet size={13} />
        <strong>REAL WALLET AKTIF</strong>
        <span className="mode-banner-sep" aria-hidden="true">·</span>
        {!connected
          ? 'Connect Phantom untuk eksekusi dana asli'
          : !isBound
            ? 'Bind wallet di panel Real Wallet dulu'
            : realAuto
              ? 'Dana asli — auto-execute (Phantom tetap tanda tangan)'
              : 'Dana asli — approve manual tiap transaksi'}
      </span>
      <button type="button" className="mode-banner-btn" onClick={() => setRealMode(false)} aria-label="Kembali ke virtual wallet">
        <IconArrowDown size={13} />
        Virtual Wallet
      </button>
    </div>
  );
}