// Focused security helpers shared by Express routes and LLM proxy code.
// Importers/callers: server.js, llmClient.js.
// User instruction: "improve keamanan dari hacker" — security headers,
// safe upstream URL validation, error redaction, and bounded IP rate limits.
import net from 'node:net';
import dns from 'node:dns/promises';

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
    // Prefixed keys: the `sk|key|token|secret` stem, plus the vendors this app
    // actually offers as providers — `AIza…` (Gemini), `xai-…`, and AWS
    // `AKIA…`/`ASIA…` access-key ids. The stem is matched as a prefix, so a
    // value with no such prefix is not covered by this rule.
    .replace(/\b(?:sk|key|token|secret)[-_]?[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[REDACTED]')
    // A raw hex private key carries no prefix to key off, so it can only be
    // caught in context. This is deliberately narrow: a 64-hex token is also
    // what a transaction hash looks like, and redacting every txHash would gut
    // the executor's crash-recovery logs. Requiring a key-ish word in front
    // leaves bare hashes readable.
    .replace(/\b(private\s*key|privatekey|privkey|keys?|secret|mnemonic|seed|passphrase)(\s*[:=]\s*)["']?(?:0x)?[0-9a-fA-F]{64}/gi,
      '$1$2[REDACTED]');
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

/** Is this address the loopback interface, and nothing wider? */
function isLoopback(address) {
  if (address === '::1') return true;
  const ipVersion = net.isIP(address);
  if (ipVersion !== 4) return false;
  const [a] = address.split('.').map(Number);
  return a === 127;
}

function hostnameIsBlocked(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_OR_METADATA_HOSTS.has(host) || host.endsWith('.internal')) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      // Not RFC1918, but still not somewhere a user-supplied baseUrl may point:
      // CGNAT (100.64/10) sits on carrier and often internal networks; 192.0.0/24
      // holds IETF protocol assignments (192.0.0.0/29 is localhost on some
      // stacks); 198.18/15 is the benchmarking block, used for internal test
      // networks. A public-looking spelling that routes inward is the whole
      // point of an SSRF guard, so the reachable ranges belong on the list.
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0)
      || (a === 198 && (b === 18 || b === 19));
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
 *
 * This is a SYNTAX check only — it sees the hostname as written, never what
 * that hostname resolves to. `127.0.0.1.nip.io` and `10.1.2.3.sslip.io` are
 * ordinary-looking names that resolve to loopback/private addresses, so a user
 * could store one as their `baseUrl` and have the server POST their Bearer key
 * to an address they chose. Blocking the name does not fix it.
 *
 * Use `assertSafeBaseUrl` (async, resolves DNS and re-checks every address)
 * anywhere a request will actually be made. This stays synchronous for the
 * config-save validation, where rejecting an obviously bad shape early is
 * still worth doing.
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

/**
 * Resolve the hostname and refuse the URL if ANY address it points at is
 * private, loopback, link-local or metadata.
 *
 * Every address is checked, not just the first: a name with several A records
 * passes if one is public and fails if any is not, because which one the
 * connection lands on is not ours to choose. A DNS failure fails closed —
 * there is no address to prove safe, so the request does not happen.
 *
 * `allowLoopback` re-permits exactly the loopback address (::1 / 127.0.0.0/8),
 * for providers that are local by design. Every other private, link-local and
 * metadata range stays blocked under that flag — `ollama` must not become a
 * tunnel to the LAN.
 */
export async function assertSafeBaseUrl(value, { allowLoopback = false } = {}) {
  if (!isSafeBaseUrl(value)) throw new Error('baseUrl tidak diizinkan (SSRF guard)');
  const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
  // An IP literal was already checked above; there is nothing left to resolve,
  // and resolving one would just re-derive the same verdict.
  if (net.isIP(host)) return new URL(value).origin;
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('baseUrl tidak diizinkan (SSRF guard: hostname tidak dapat diresolve)');
  }
  for (const { address } of records) {
    if (!hostnameIsBlocked(address)) continue;
    if (allowLoopback && isLoopback(address)) continue;
    throw new Error('baseUrl tidak diizinkan (SSRF guard: hostname menunjuk ke alamat internal)');
  }
  return new URL(value).origin;
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