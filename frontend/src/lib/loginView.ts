// Pure helpers for the login screen — the parts worth testing without a DOM.
// Importers/callers: pages/Login.tsx. API: vaultLabel, credentialError.
// Sibling of walletView.ts (same "pure view helpers" role).

/** Submit-button label while the password login is in flight. */
export function vaultLabel(pending: boolean): string {
  return pending ? 'Melogin…' : 'Masuk';
}

/**
 * The first thing wrong with the credentials as typed, or null when they are
 * worth sending.
 *
 * Checked here rather than relying on `required`: the browser's own bubble
 * cannot say which field is wrong in the app's language, and a whitespace-only
 * username would pass `required` and then fail at the server with a generic
 * "Invalid credentials" — a message that hides a typo behind an auth error.
 */
export function credentialError(username: string, password: string): string | null {
  if (!username.trim()) return 'Username wajib diisi';
  if (!password) return 'Password wajib diisi';
  return null;
}
