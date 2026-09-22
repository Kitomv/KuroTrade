// Promise-based confirm dialog — replaces native confirm()/prompt().
// Importers/callers: Portfolio (sell, reset), Leaderboard (reset-pw, delete),
// Agents (execute order), RealTradePanel (swap). API: `confirmAction(opts) →
// Promise<string|boolean>`; mounts ConfirmProvider in App. `input` renders a
// text field and resolves its value; otherwise resolves true/false.
// User instruction: "improve user experience:ALL".
import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { Modal } from './Modal';

type InputType = 'number' | 'password' | 'text';

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: { label?: string; type?: InputType; placeholder?: string; initial?: string; required?: boolean };
  onConfirm?: (value: string | null) => void;
}

interface OpenRequest extends ConfirmOptions {
  resolve: (value: string | boolean | null) => void;
}

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<string | boolean | null>>(() => Promise.resolve(false));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenRequest | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const confirmAction = useCallback((opts: ConfirmOptions) => new Promise<string | boolean | null>((resolve) => {
    setValue(opts.input?.initial ?? '');
    setOpen({ ...opts, resolve });
  }), []);

  useEffect(() => {
    if (open?.input) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const close = useCallback((result: string | boolean | null) => {
    setOpen((cur) => { cur?.resolve(result); return null; });
  }, []);

  const needsValue = Boolean(open?.input?.required);
  const confirmDisabled = needsValue && !String(value).trim();

  return (
    <ConfirmContext.Provider value={confirmAction}>
      {children}
      {open && (
        <Modal
          title={open.title}
          onClose={() => close(false)}
          maxWidth={400}
          actions={
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={() => close(false)} autoFocus>
                {open.cancelLabel ?? 'Batal'}
              </button>
              <button
                type="button"
                className="btn primary"
                style={{ flex: 1, ...(open.danger ? { background: 'rgba(239,68,68,.16)', borderColor: 'rgba(239,68,68,.5)', color: 'var(--down)' } : {}) }}
                disabled={confirmDisabled}
                onClick={() => close(open.input ? String(value).trim() : true)}
              >
                {open.confirmLabel ?? 'Ya'}
              </button>
            </div>
          }
        >
          {typeof open.message === 'string' ? <p className="modal-text">{open.message}</p> : open.message}
          {open.input && (
            <div className="modal-input">
              {open.input.label && <label className="modal-label">{open.input.label}</label>}
              <input
                ref={inputRef}
                className="input"
                type={open.input.type ?? 'text'}
                style={{ width: '100%' }}
                placeholder={open.input.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !confirmDisabled) close(String(value).trim());
                  if (e.key === 'Escape') close(false);
                }}
              />
            </div>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}