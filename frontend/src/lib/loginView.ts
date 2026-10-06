// Pure helpers for the login screen — the parts worth testing without a DOM.
// Importers/callers: pages/Login.tsx. API: PendingAuth, vaultLabel, rejectionMessage.
// Sibling of walletView.ts (same "pure view helpers" role).

/**
 * Which entry path is in flight, and how far along it is.
 *
 * `step` exists so the button can name what it is waiting for: a wallet login
 * spends most of its time inside MetaMask, and a label stuck on "signing…"
 * while the extension is still opening reads to the user as a hang.
 */
export type PendingAuth =
  | { kind: 'password'; step: 'login' }
  | { kind: 'wallet'; step: 'connect' | 'sign' | 'verify' };

/** Submit-button label for the password vault. */
export function vaultLabel(pending: PendingAuth | null): string {
  if (pending?.kind !== 'password') return 'Masuk';
  return pending.step === 'login' ? 'Melogin…' : 'Memverifikasi…';
}

/**
 * Submit-button label for the MetaMask path.
 *
 * Names the step in flight because most of the wait happens inside the
 * extension: a label stuck on "signing…" while MetaMask is still opening
 * reads to the user as a hang.
 */
export function walletLabel(pending: PendingAuth | null): string {
  if (pending?.kind !== 'wallet') return 'Masuk dengan MetaMask';
  if (pending.step === 'connect') return 'Buka MetaMask…';
  if (pending.step === 'sign') return 'Tanda tangani di MetaMask…';
  return 'Memverifikasi…';
}

/**
 * A wallet-login failure in the user's language.
 *
 * MetaMask reports both a rejection and its generic internal failure as opaque
 * provider errors. The generic one is usually several wallet extensions
 * fighting over `window.ethereum`; its own message names neither the cause nor
 * the fix, so translate it rather than showing it raw.
 */
export function rejectionMessage(ex: unknown): string {
  const raw = ex instanceof Error ? ex.message : typeof ex === 'string' ? ex : '';
  if (/user rejected|user denied|rejected the request/i.test(raw)) {
    return 'Signature dibatalkan di MetaMask';
  }
  if (/unexpected error/i.test(raw)) {
    return 'MetaMask gagal connect. Nonaktifkan ekstensi wallet lain (Rabby/Coinbase/Trust), lalu reload halaman ini.';
  }
  return raw || 'Login wallet gagal';
}
