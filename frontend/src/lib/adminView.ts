// Pure helpers for the Admin page — mirrors the SERVER's account rules so the
// form fails fast with the same message the API would return.
//
// These are duplicated from backend/src/server.js on purpose: the server is
// still the authority (it validates every request), and this copy exists only
// to save a round trip. If the two ever disagree the server wins, so keep the
// bounds and the character class identical when either side changes.
//
// Precedent for pure testable helpers: lib/loginView.ts, lib/walletView.ts.

/** Username bounds — must match POST /api/admin/users. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

/** Character class the server accepts for a username. */
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

/** Minimum password length — must match the server's two password routes. */
export const PASSWORD_MIN = 8;

/**
 * The first thing wrong with a new account, or null when it is acceptable.
 * Order matches the server's own checks so the messages line up.
 */
export function newUserError(username: string, password: string): string | null {
  const name = username.trim();
  if (!name) return 'Username wajib diisi';
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
    return `Username harus ${USERNAME_MIN}–${USERNAME_MAX} karakter`;
  }
  if (!USERNAME_RE.test(name)) {
    return 'Username hanya boleh huruf, angka, titik, garis bawah, dan strip';
  }
  return passwordError(password);
}

/** The first thing wrong with a password, or null. */
export function passwordError(password: string): string | null {
  if (!password) return 'Password wajib diisi';
  if (password.length < PASSWORD_MIN) return `Password minimal ${PASSWORD_MIN} karakter`;
  return null;
}
