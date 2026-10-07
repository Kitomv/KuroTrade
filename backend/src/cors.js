// CORS policy — extracted from server.js so the allow-list rules are testable
// without booting Express.
//
// Why this exists at all: in the local setup the frontend is served by the same
// process as the API, so every request is same-origin and CORS never runs. In
// the split deployment (frontend on Vercel, backend on Railway) every API call
// is cross-origin, and a missing/wrong Access-Control-Allow-Origin is not a
// loud failure — the browser reports a generic 500/network error and the server
// logs nothing, because the request that failed never reached it. So the rules
// are pinned in cors.test.mjs instead of being reasoned about at deploy time.
//
// Allow rules:
//   1. Origins named in ALLOWED_ORIGINS (comma-separated) — the deployed
//      frontend origin. Empty by default: nothing is allowed until the operator
//      names it.
//   2. http://localhost[:port] and http://127.0.0.1[:port] — the Vite dev
//      server. Exact host match, never a substring: a rule like
//      "hostname starts with localhost" would approve localhost.evil.com.

const DEV_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Split ALLOWED_ORIGINS into valid origins, reporting the entries that had to
 * be dropped so the caller can warn at boot. A malformed entry is otherwise a
 * silent lockout: the operator sets a value, the frontend still cannot reach
 * the API, and nothing says why.
 */
export function classifyAllowedOrigins(value) {
  const origins = [];
  const dropped = [];
  if (!value || typeof value !== 'string') return { origins, dropped };
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      // `.origin` normalises case and strips the trailing slash a pasted URL
      // carries — `https://a.example/` never equals the browser's Origin
      // header value `https://a.example`, so it would silently never match.
      origins.push(new URL(trimmed).origin);
    } catch {
      dropped.push(trimmed);
    }
  }
  return { origins, dropped };
}

/** Valid origins from a comma-separated env value, order preserved. */
export function parseAllowedOrigins(value) {
  return classifyAllowedOrigins(value).origins;
}

/**
 * Build the origin policy and the Express middleware from one env value.
 * Read once at boot; changing the env needs a restart, as usual.
 */
export function createCors(envValue) {
  const { origins, dropped } = classifyAllowedOrigins(envValue);
  const allowed = new Set(origins);

  const isOriginAllowed = (origin) => {
    if (!origin || typeof origin !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (allowed.has(parsed.origin)) return true;
    return parsed.protocol === 'http:' && DEV_ORIGIN_HOSTS.has(parsed.hostname);
  };

  const corsMiddleware = (req, res, next) => {
    const origin = req.headers.origin;
    // Echo the origin only when it is allowed; a refused origin gets no
    // allow header, which is what makes the browser block the response.
    if (isOriginAllowed(origin)) res.set('Access-Control-Allow-Origin', origin);
    // The response depends on the Origin request header — without Vary, a
    // shared cache could replay an allowed response to a different origin.
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Every Bearer request (including the dashboard's 5s polls) is preflighted,
    // so caching the preflight for 10 minutes removes a round trip from every
    // poll. 600s is the cap Chrome honours.
    res.set('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };

  return { isOriginAllowed, corsMiddleware, droppedOrigins: dropped };
}
