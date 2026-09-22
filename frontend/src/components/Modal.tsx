// Shared modal overlay — Esc + click-outside close, focus trap, focus restore.
// Importers/callers: Agents (LLM stack), Sidebar (change password), Leaderboard
// (admin panel). API: `<Modal title onClose actions maxWidth>children</Modal>`.
// No data schema — presentational. User instruction: "improve user experience:ALL".
import { useEffect, useRef, ReactNode } from 'react';
import { IconClose } from './Icons';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  maxWidth?: number;
}

export function Modal({ title, onClose, children, actions, maxWidth = 480 }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc to close + focus restore to the opener.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // lock scroll behind the modal
    const focusable = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const first = dialogRef.current?.querySelector<HTMLElement>(focusable);
    first?.focus();

    const onFocus = (e: FocusEvent) => {
      // Trap Tab inside the dialog; wrap around when leaving at either end.
      if (!dialogRef.current?.contains(e.target as Node)) {
        first?.focus();
      }
    };
    addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="card modal-dialog"
        style={{ maxWidth, ...(actions ? { paddingBottom: 0 } : {}) }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="modal-head">
          <strong className="modal-title">{title}</strong>
          <button type="button" className="btn icon" style={{ minHeight: 32, minWidth: 32, padding: 4 }} onClick={onClose} aria-label="Tutup">
            <IconClose size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}