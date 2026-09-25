// Shared HotWallet state + actions — one polling source for the panel and the
// global emergency-pause banner. Mounted at the shell level (App.tsx) inside
// the WalletProviderGate so it survives page navigation.
// API: useHotWallet() → { status, autoEnabled, paused, balanceSol, generate, toggleAuto, pause }
// Importers/callers: HotWalletPanel.tsx, EmergencyPauseBanner.tsx, App.tsx.
// Data schema: in-memory {status:{exists,publicKey}, autoEnabled, paused, balanceSol}.
// User instruction: "mending buatin mode real wallet sendiri" — single source of truth pattern.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';

interface Status {
  exists: boolean;
  publicKey: string | null;
  network?: string;
}

interface HotWalletState {
  status: Status | null;
  autoEnabled: boolean;
  paused: boolean;
  balanceSol: number;
  loading: boolean;
  error: string;
  generate: () => Promise<void>;
  toggleAuto: (enable: boolean) => Promise<void>;
  pause: (on: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const HotWalletContext = createContext<HotWalletState | null>(null);

export function HotWalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [balanceSol, setBalanceSol] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, a, p, b] = await Promise.all([
        api.hotWalletStatus(),
        api.hotWalletAuto().catch(() => ({ autoEnabled: false })),
        api.hotWalletEmergencyPause().catch(() => ({ paused: false })),
        api.hotWalletBalance().catch(() => ({ exists: false, publicKey: null, balanceSol: 0 })),
      ]);
      setStatus(s);
      setAutoEnabled(Boolean(a.autoEnabled));
      setPaused(Boolean(p.paused));
      setBalanceSol(b.balanceSol ?? 0);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Gagal memuat status hot wallet');
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll every 15s, but PAUSE while the tab is hidden: a backgrounded dashboard
  // has nobody watching it, and four endpoints per tick (status/auto/pause/
  // balance) is enough traffic to trip the per-user rate limit on its own.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      refresh();
      id = setInterval(refresh, 15_000);
    };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  const generate = useCallback(async () => {
    setError('');
    const r = await api.hotWalletGenerate();
    setStatus({ exists: true, publicKey: r.publicKey });
    setBalanceSol(0);
    // Re-read so createdAt/balance come from the server, not a local guess.
    refresh().catch(() => {});
  }, [refresh]);

  const toggleAuto = useCallback(async (enable: boolean) => {
    setError('');
    const r = await api.setHotWalletAuto(enable);
    setAutoEnabled(Boolean(r.autoEnabled));
  }, []);

  // Emergency pause is global and also clears auto-execute server-side.
  const pause = useCallback(async (on: boolean) => {
    setError('');
    const r = await api.setHotWalletEmergencyPause(on);
    setPaused(Boolean(r.paused));
    if (on) setAutoEnabled(false);
  }, []);

  const value: HotWalletState = {
    status,
    autoEnabled,
    paused,
    balanceSol,
    loading,
    error,
    generate,
    toggleAuto,
    pause,
    refresh,
  };

  return <HotWalletContext.Provider value={value}>{children}</HotWalletContext.Provider>;
}

export function useHotWallet(): HotWalletState {
  const ctx = useContext(HotWalletContext);
  if (!ctx) throw new Error('useHotWallet must be used within HotWalletProvider');
  return ctx;
}