// Shared modal overlay — Esc + click-outside close, focus trap, focus restore.
// Importers/callers: Agents (LLM stack), Settings/Sidebar (change password),
// RealWallet (modal + portfolio). API: `<Modal title onClose actions maxWidth>children</Modal>`.
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
  // onClose inline di caller (= identitas baru tiap render parent / tiap poll
  // 4s). Effect di bawah harus jalan sekali saat mount, bukan tiap onClose
  // ganti — kalau tidak, cleanup prev?.focus() + first?.focus() narik kursor
  // keluar field ke tombol close setiap tick.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount-once. onClose inline ganti identitas tiap poll 4s — deps [onClose]
  // bikin effect rerun + focus ditarik ke tombol X tiap tick.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // lock scroll behind the modal
    const focusable = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    // Prefer field form, bukan tombol X di header.
    const body = dialogRef.current?.querySelector<HTMLElement>('.modal-body');
    const first = body?.querySelector<HTMLElement>('input, select, textarea') ?? dialogRef.current?.querySelector<HTMLElement>(focusable);
    first?.focus();

    // Guard against recursive refocus: `first.focus()` dispatches a new
    // 'focusin' (potentially synchronously). If focus is yanked back to the SAME
    // `first`, that fires another 'focusin' → infinite recursion → RangeError.
    // Only refocus when a real target actually sits outside this dialog. Also,
    // when a nested Modal opens (e.g. RealWalletModal running a confirm()), its
    // focus belongs to the inner dialog — don't fight it.
    let lastTrapTarget: Node | null = null;
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (dialogRef.current?.contains(target)) { lastTrapTarget = null; return; }
      // Focus belongs to another modal on top (nested confirm) — don't fight it.
      if ((target as HTMLElement)?.closest?.('.modal-backdrop')) return;
      // Only move focus if it didn't already arrive at the trap boundary.
      if (target === lastTrapTarget) return;
      lastTrapTarget = target;
      first?.focus();
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