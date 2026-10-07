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
//      server — but ONLY when the TCP connection itself came from loopback.
//      Exact host match, never a substring: a rule like "hostname starts with
//      localhost" would approve localhost.evil.com. The socket requirement is
//      what keeps this rule from being a production hole: the Origin header is
//      client-controlled, so without it any remote caller could claim a
//      localhost origin and be approved. A deployed instance sees every
//      request through the platform edge, whose socket is never loopback.

const DEV_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Is this socket address the loopback interface? The socket peer is ground
 * truth — unlike req.ip, it cannot be set by the client. Accepts `127.0.0.0/8`
 * in dotted form, `::1`, and the IPv4-mapped spellings Node hands back on
 * dual-stack listeners (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
 */
function isLoopbackAddress(address) {
  if (!address || typeof address !== 'string') return false;
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4)) return true;
  // Hextet spelling of an IPv4-mapped loopback (::ffff:7f00:1 = 127.0.0.1):
  // the first hextet's high byte is the first octet.
  if (address.startsWith('::ffff:')) {
    const m = ipv4.match(/^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i);
    if (m && (parseInt(m[1], 16) >> 8) === 0x7f) return true;
  }
  return false;
}

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

  const isOriginAllowed = (origin, socketAddress) => {
    if (!origin || typeof origin !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (allowed.has(parsed.origin)) return true;
    return parsed.protocol === 'http:'
      && DEV_ORIGIN_HOSTS.has(parsed.hostname)
      && isLoopbackAddress(socketAddress);
  };

  const corsMiddleware = (req, res, next) => {
    const origin = req.headers.origin;
    // Echo the origin only when it is allowed; a refused origin gets no
    // allow header, which is what makes the browser block the response.
    // The socket peer decides dev-rule eligibility — never req.ip, which the
    // client can influence through forwarding headers.
    if (isOriginAllowed(origin, req.socket?.remoteAddress)) res.set('Access-Control-Allow-Origin', origin);
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
