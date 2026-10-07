// Where the API lives.
//
// In the local setup the frontend is served by the backend (or by Vite with an
// /api proxy), so a relative path is same-origin and works as-is. In the split
// deployment (frontend on Vercel, backend on Railway) a relative /api/... call
// hits the static host and 404s — the request never reaches the backend, so no
// backend log can reveal it.
//
// VITE_API_BASE is inlined at BUILD time, so it must be set in the build
// environment (Vercel project settings), not at runtime. Unset/empty keeps the
// relative path, which is what local dev and the single-process deployment
// need.

/**
 * Prefix `path` with the configured API origin. A falsy/blank base returns the
 * path unchanged (relative), preserving the local-dev behaviour.
 */
export function resolveApiUrl(path: string, base: string | undefined): string {
  const origin = base?.trim().replace(/\/+$/, '') ?? '';
  if (!origin) return path;
  return path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`;
}

/** The URL every API call must be built from. See the file header. */
export function apiUrl(path: string): string {
  return resolveApiUrl(path, import.meta.env.VITE_API_BASE);
}
