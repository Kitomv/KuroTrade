// Focused security helpers shared by Express routes and LLM proxy code.
// Importers/callers: server.js, llmClient.js.
// User instruction: "improve keamanan dari hacker" — security headers,
// safe upstream URL validation, error redaction, and bounded IP rate limits.
import net from 'node:net';

const PRIVATE_OR_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data.ec2.internal',
]);

export function securityHeaders(req, res, next) {
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src \'self\' data: https:',
    "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** Redact bearer tokens and common API-key prefixes before logs/errors. */
export function redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token|secret)[-_]?[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]');
}

/** Keep upstream details useful without returning credentials/long internals. */
export function sanitizeError(value) {
  return redact(value)
    .replace(/https?:\/\/[^\s)]+/gi, (url) => {
      try { return new URL(url).origin; } catch { return '[upstream]'; }
    })
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}

/**
 * Is this an IPv6 literal that carries an embedded IPv4 address?
 *
 * WHAT the URL parser hands us: it normalises the address, so the dotted form
 * `::ffff:169.254.169.254` comes back as `::ffff:a9fe:a9fe`. Matching the
 * dotted spelling therefore never fires. Parse the trailing hextet pair
 * instead and re-derive the octets.
 *
 * WHY it matters: connecting to ::ffff:169.254.169.254 reaches 169.254.169.254
 * verbatim, so without this a cloud metadata endpoint was reachable simply by
 * writing the address in a form the prefix checks do not match.
 *
 * Returns the dotted IPv4 string, or null when this is not a mapped form.
 */
function extractMappedIPv4(host) {
  // Only ::ffff:a.b.c.d and ::a.b.c.d embed an IPv4 address — that is the
  // 5th/6th hextet pair, which is what the two captures below hold.
  const m = host.match(/^::(ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function hostnameIsBlocked(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_OR_METADATA_HOSTS.has(host) || host.endsWith('.internal')) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ipVersion === 6) {
    const mapped = extractMappedIPv4(host);
    if (mapped) return hostnameIsBlocked(mapped);
    return host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
  }
  return false;
}

/**
 * Validate a user-supplied OpenAI-compatible endpoint. Localhost is allowed
 * for the configured local 9router/Ollama setup; cloud metadata/private IPs
 * and embedded credentials are not.
 */
export function isSafeBaseUrl(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (hostnameIsBlocked(url.hostname)) return false;
    return Boolean(url.hostname) && url.pathname.length < 512;
  } catch {
    return false;
  }
}

/** Small in-memory limiter with periodic stale-entry pruning. */
function createLimiter({ max, windowMs, keyOf }) {
  const entries = new Map();
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) if (now > entry.resetAt) entries.delete(key);
  }, Math.max(windowMs, 60_000));
  prune.unref?.();
  return (req, res, next) => {
    const key = keyOf(req);
    const now = Date.now();
    let entry = entries.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
    }
    next();
  };
}

/** Per-IP limiter — for pre-auth routes (login) and IP-scoped upstream quota. */
export function ipRateLimit({ max, windowMs }) {
  return createLimiter({
    max,
    windowMs,
    keyOf: (req) => String(req.ip || req.socket?.remoteAddress || 'unknown'),
  });
}

/**
 * Per-user limiter keyed by `req.userId` (set by the auth guard). For
 * post-auth routes: one IP with many users behind NAT/hotel must not
 * cross-block, and a single user's dashboard polling gets an independent
 * budget. Falls back to IP when unauthenticated so it can never be unbounded.
 */
export function userRateLimit({ max, windowMs }) {
  return createLimiter({
    max,
    windowMs,
    keyOf: (req) => `u:${req.userId ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`,
  });
}