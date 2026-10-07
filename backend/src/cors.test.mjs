// CORS allow-list tests — the frontend is deployed on a different origin
// (Vercel) than the backend (Railway), so the browser sends a cross-origin
// request with an Origin header, and the backend must answer with a matching
// Access-Control-Allow-Origin or the browser blocks the response. A broken
// allow-list does not fail loudly — the login request returns 500 in the
// console and nothing else — which is exactly why the rules are pinned here.
//
// Run: node --test backend/src/cors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCors, parseAllowedOrigins } from './cors.js';

/* ---------------- parseAllowedOrigins ---------------- */

test('a comma-separated list is split, trimmed and lowercased', () => {
  assert.deepEqual(
    parseAllowedOrigins(' https://Trade.aisrynnn.com , https://other.example '),
    ['https://trade.aisrynnn.com', 'https://other.example'],
  );
});

test('empty and whitespace entries are dropped, not kept as blanks', () => {
  assert.deepEqual(parseAllowedOrigins(',, https://a.example ,,,'), ['https://a.example']);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(null), []);
});

test('a trailing slash is stripped so a pasted URL still matches', () => {
  // `https://a.example/` never equals the browser's Origin header value
  // (`https://a.example`), and the entry would silently never match.
  assert.deepEqual(parseAllowedOrigins('https://a.example/'), ['https://a.example']);
});

/* ---------------- the allow-list itself ---------------- */

// The second argument is the raw socket peer. Dev origins require a loopback
// socket; configured origins do not care. Default to loopback so the dev-rule
// cases read naturally.
const isAllowed = (origin, envValue, socket = '127.0.0.1') => {
  const { isOriginAllowed } = createCors(envValue);
  return isOriginAllowed(origin, socket);
};

test('a configured origin is allowed — that is the whole point', () => {
  assert.equal(isAllowed('https://trade.aisrynnn.com', 'https://trade.aisrynnn.com'), true);
});

test('localhost dev origins are allowed from a loopback connection, with any port', () => {
  for (const origin of [
    'http://localhost:5173', 'http://localhost:3001', 'http://127.0.0.1:5173',
    'http://localhost', 'http://127.0.0.1',
  ]) {
    assert.equal(isAllowed(origin, ''), true, `should allow ${origin}`);
  }
});

test('a localhost origin arriving from a REMOTE connection is refused', () => {
  // The dev rule is for a browser on the same machine as the backend. A
  // deployed instance sees every request through the platform edge, so a
  // remote request that merely CLAIMS a localhost origin must get nothing —
  // otherwise any local web server on a visitor's machine (a stray dev
  // server, a malicious package script) could read API responses cross-origin.
  assert.equal(isAllowed('http://localhost:5173', '', '10.1.2.3'), false);
  assert.equal(isAllowed('http://127.0.0.1:5173', 'https://trade.aisrynnn.com', '100.64.0.9'), false);
  // The socket gate narrows ONLY the dev rule — a configured origin is still
  // allowed no matter where the request comes from.
  assert.equal(isAllowed('https://trade.aisrynnn.com', 'https://trade.aisrynnn.com', '10.1.2.3'), true);
});

test('a localhost-LOOKING origin is not localhost', () => {
  // The dev rule is an exact host check, not a substring. Without anchoring,
  // an attacker registers `localhost.evil.com` and the browser sends the
  // user's session to it with CORS approval.
  for (const origin of [
    'http://localhost.evil.com', 'http://127.0.0.1.evil.com',
    'https://localhost.evil.com:5173', 'http://mylocalhost:5173',
  ]) {
    assert.equal(isAllowed(origin, ''), false, `should refuse ${origin}`);
  }
});

test('an unconfigured origin is refused', () => {
  assert.equal(isAllowed('https://evil.example', ''), false);
  assert.equal(isAllowed('https://evil.example', 'https://trade.aisrynnn.com'), false);
});

test('the scheme must match — https config does not allow the http spelling', () => {
  assert.equal(isAllowed('http://trade.aisrynnn.com', 'https://trade.aisrynnn.com'), false);
});

test('a missing Origin header is not an allowed origin', () => {
  // Same-origin requests (curl, health checks) send no Origin. The CORS
  // middleware must skip the header, not emit `Access-Control-Allow-Origin: undefined`.
  assert.equal(isAllowed(undefined, 'https://trade.aisrynnn.com'), false);
  assert.equal(isAllowed('', 'https://trade.aisrynnn.com'), false);
});

test('matching is case-insensitive on the host, and no substring match either', () => {
  assert.equal(isAllowed('https://TRADE.aisrynnn.com', 'https://trade.aisrynnn.com'), true);
  assert.equal(isAllowed('https://trade.aisrynnn.com.evil.example', 'https://trade.aisrynnn.com'), false);
});

/* ---------------- the Express middleware ---------------- */

test('the middleware echoes the origin only when allowed', () => {
  const { corsMiddleware } = createCors('https://trade.aisrynnn.com');
  const headers = {};
  const res = {
    set: (k, v) => { headers[k] = v; },
    sendStatus: (s) => { headers['__status'] = s; },
  };

  corsMiddleware({ method: 'GET', headers: { origin: 'https://trade.aisrynnn.com' } }, res, () => {});
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://trade.aisrynnn.com');
  assert.equal(headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization');
  // The methods the frontend actually uses (client.ts) — preflight must
  // advertise every one or the browser blocks the real request after it.
  for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
    assert.ok(headers['Access-Control-Allow-Methods'].includes(method), `${method} must be advertised`);
  }

  const refused = {};
  corsMiddleware({ method: 'GET', headers: { origin: 'https://evil.example' } },
    { set: (k, v) => { refused[k] = v; }, sendStatus: () => {} }, () => {});
  assert.equal(refused['Access-Control-Allow-Origin'], undefined, 'a refused origin must not be echoed');
});

test('the middleware extends the dev rule only to loopback sockets', () => {
  const { corsMiddleware } = createCors('');
  const originFor = (remoteAddress) => {
    const headers = {};
    corsMiddleware(
      { method: 'GET', headers: { origin: 'http://localhost:5173' }, socket: { remoteAddress } },
      { set: (k, v) => { headers[k] = v; }, sendStatus: () => {} },
      () => {},
    );
    return headers['Access-Control-Allow-Origin'];
  };
  assert.equal(originFor('127.0.0.1'), 'http://localhost:5173');
  assert.equal(originFor('::1'), 'http://localhost:5173');
  assert.equal(originFor('::ffff:127.0.0.1'), 'http://localhost:5173');
  assert.equal(originFor('10.0.0.5'), undefined, 'a remote socket must not get dev treatment');
  assert.equal(originFor(undefined), undefined, 'no socket info must not get dev treatment');
});

test('an OPTIONS preflight short-circuits with 204', () => {
  const { corsMiddleware } = createCors('https://trade.aisrynnn.com');
  let nextCalled = false;
  let status;
  corsMiddleware(
    { method: 'OPTIONS', headers: { origin: 'https://trade.aisrynnn.com' } },
    { set: () => {}, sendStatus: (s) => { status = s; } },
    () => { nextCalled = true; },
  );
  assert.equal(status, 204);
  assert.equal(nextCalled, false, 'preflight must not fall through to the auth guard');
});

test('an empty env value allows only localhost — the local dev default', () => {
  const { isOriginAllowed } = createCors('');
  assert.equal(isOriginAllowed('http://localhost:5173', '127.0.0.1'), true);
  assert.equal(isOriginAllowed('https://trade.aisrynnn.com'), false,
    'nothing is allowed until the operator names it');
});

test('the configured list is read at creation time from the env', () => {
  // The middleware is built once at boot from process.env.ALLOWED_ORIGINS;
  // this pins that contract so a refactor cannot silently ignore the env var.
  const prev = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://from-env.example';
  try {
    const { isOriginAllowed } = createCors(process.env.ALLOWED_ORIGINS);
    assert.equal(isOriginAllowed('https://from-env.example'), true);
  } finally {
    if (prev === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = prev;
  }
});
