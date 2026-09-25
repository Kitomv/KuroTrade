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
import { useHotWallet } from './HotWalletContext';
import { IconWallet, IconArrowDown } from './Icons';

export function WalletModeBanner() {
  const { loaded, connected, isBound, realMode, setRealMode } = useRealWallet();
  // Auto-execution is the HOT WALLET's job now (server-side signing, no Phantom
  // popup). `realAuto` is a deprecated hardcoded false, so reading it here would
  // always claim "approve manual" even while the hot wallet autonomously spends.
  const { autoEnabled: hotAuto, paused: hotPaused } = useHotWallet();
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
            : hotPaused
              ? 'Hot wallet dijeda (emergency pause) — tidak ada eksekusi otomatis'
              : hotAuto
                ? 'Dana asli — hot wallet auto-execute (tanpa popup Phantom)'
                : 'Dana asli — approve manual tiap transaksi'}
      </span>
      <button type="button" className="mode-banner-btn" onClick={() => setRealMode(false)} aria-label="Kembali ke virtual wallet">
        <IconArrowDown size={13} />
        Virtual Wallet
      </button>
    </div>
  );
}