// Global emergency-pause banner. Renders at the top of <main> when the hot
// wallet is emergency-paused — most users visit Portfolio/Agents rarely, so a
// paused autopilot (real money) must be visible from every page.
// Importers/callers: App.tsx (beside WalletModeBanner).
// API: useHotWallet() → { paused, pause }. Presentational, no new endpoints.
// User instruction: "Emergency pause lives at bottom of two long pages… an admin
// can pause and nothing surfaces on the other five pages." → surface globally.
import { useHotWallet } from './HotWalletContext';
import { IconShield, IconPower } from './Icons';

export function EmergencyPauseBanner() {
  const { paused, pause } = useHotWallet();
  if (!paused) return null;

  return (
    <div className="mode-banner" role="alert">
      <span className="mode-banner-dot" aria-hidden="true" />
      <span className="mode-banner-text">
        <IconShield size={13} />
        <strong>EMERGENCY PAUSE AKTIF</strong>
        <span className="mode-banner-sep" aria-hidden="true">·</span>
        Semua trade otomatis hot wallet dihentikan (global)
      </span>
      <button type="button" className="mode-banner-btn" onClick={() => pause(false)} aria-label="Matikan emergency pause">
        <IconPower size={13} />
        Matikan Pause
      </button>
    </div>
  );
}