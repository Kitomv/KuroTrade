// Shared toast system for the dashboard — one provider, stacked bottom-right.
// Importers/callers: every page that previously hand-rolled a toast (Overview,
// Portfolio, Leaderboard, App). API: `useToast() → { showToast(msg, type?) }`,
// type: 'default' | 'success' | 'error'. No data schema — ephemeral UI state.
// User instruction: "improve user experience:ALL" — one toast system, no dupes.
import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';

export type ToastType = 'default' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  leaving: boolean;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idCounter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const showToast = useCallback((message: string, type: ToastType = 'default') => {
    const id = ++idCounter.current;
    setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
    const ttl = type === 'error' ? 4500 : type === 'success' ? 3000 : 3500;
    // Two-phase dismiss: mark `leaving` (out-animation) then remove.
    setTimeout(() => setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t))), ttl);
    setTimeout(() => dismiss(id), ttl + 260);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ showToast, toasts, dismissToast: dismiss }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}${t.leaving ? ' out' : ''}`} onClick={() => dismiss(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}