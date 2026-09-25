// EVM Hot Wallet Context — Base chain (manual execution via 1inch).
// Separate from Solana HotWalletContext to keep concerns isolated.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';

interface EvmWalletState {
  status: { exists: boolean; address: string | null } | null;
  balanceEth: string;
  loading: boolean;
  error: string;
  generate: () => Promise<void>;
  importKey: (privateKey: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const EvmWalletContext = createContext<EvmWalletState | null>(null);

export function EvmWalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<{ exists: boolean; address: string | null } | null>(null);
  const [balanceEth, setBalanceEth] = useState('0');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        api.evmStatus(),
        api.evmBalance().catch(() => ({ exists: false, address: null, balanceNative: '0' })),
      ]);
      setStatus(s);
      setBalanceEth(b.balanceNative ?? '0');
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Gagal memuat status EVM wallet');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      refresh();
      id = setInterval(refresh, 30_000);
    };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  const generate = useCallback(async () => {
    setError('');
    const r = await api.evmGenerate();
    setStatus({ exists: true, address: r.address });
    refresh().catch(() => {});
  }, [refresh]);

  const importKey = useCallback(async (privateKey: string) => {
    setError('');
    const r = await api.evmImport(privateKey);
    setStatus({ exists: true, address: r.address });
    refresh().catch(() => {});
  }, [refresh]);

  const value: EvmWalletState = {
    status: status ?? { exists: false, address: null },
    balanceEth,
    loading,
    error,
    generate,
    importKey,
    refresh,
  };

  return (
    <EvmWalletContext.Provider value={value}>
      {children}
    </EvmWalletContext.Provider>
  );
}

export function useEvmWallet(): EvmWalletState {
  const ctx = useContext(EvmWalletContext);
  if (!ctx) throw new Error('useEvmWallet must be used within EvmWalletProvider');
  return ctx;
}
