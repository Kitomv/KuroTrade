// Verifies the split-deployment wiring: the frontend on Vercel and the backend
// on Railway are different origins, so every API call must be built from
// VITE_API_BASE. A regression here is invisible in every local setup (relative
// paths work same-origin) and shows up only in production as a generic network
// error on the login screen — which is exactly why it is pinned in the gate.
//
// Run: npm run check  (from frontend/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveApiUrl } from '../src/lib/apiBase.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf-8');

const log: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const assert = (label: string, ok: boolean, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
};

/* ---------- resolveApiUrl ---------- */

// No base = local dev / single-process deployment: the relative path must
// survive byte-identical, because that is what the Vite proxy and the
// same-origin deployment both rely on.
check('an unset base keeps the relative path', resolveApiUrl('/api/login', undefined), '/api/login');
check('an empty base keeps the relative path', resolveApiUrl('/api/login', ''), '/api/login');
check('a whitespace base keeps the relative path', resolveApiUrl('/api/login', '   '), '/api/login');

// With a base, the path must land on the backend origin.
check('a configured base is prefixed',
  resolveApiUrl('/api/login', 'https://kuro.up.railway.app'), 'https://kuro.up.railway.app/api/login');
// A trailing slash on the base is the common paste mistake; without stripping
// it the URL becomes `https://host//api/login`, which some edges 404.
check('a trailing slash on the base does not double up',
  resolveApiUrl('/api/login', 'https://kuro.up.railway.app/'), 'https://kuro.up.railway.app/api/login');
check('several trailing slashes are all stripped',
  resolveApiUrl('/api/login', 'https://kuro.up.railway.app///'), 'https://kuro.up.railway.app/api/login');
// A path without a leading slash must still join with exactly one slash.
check('a bare path joins with one slash',
  resolveApiUrl('api/login', 'https://kuro.up.railway.app'), 'https://kuro.up.railway.app/api/login');

/* ---------- every fetch site goes through the helper ---------- */

const client = read('../src/api/client.ts');
const stream = read('../src/hooks/useAgentStream.ts');

// The two call sites in client.ts (req + exportCsv) and the SSE site in
// useAgentStream.ts are the ONLY places the app talks to the API. All three
// must route through apiUrl, or one of them silently targets the static host.
// Counted, not just "somewhere present": with a presence test, reverting ONE
// of the two client.ts sites still passes because the other one matches.
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
assert('client.ts imports the helper', /import \{ apiUrl \} from '\.\.\/lib\/apiBase'/.test(client),
  'client.ts lost the apiUrl import');
assert('useAgentStream.ts imports the helper', /import \{ apiUrl \} from '\.\.\/lib\/apiBase'/.test(stream),
  'useAgentStream.ts lost the apiUrl import');
assert('both client.ts fetch sites pass apiUrl(...)',
  count(client, /fetch\(apiUrl\(/g) === 2, `found ${count(client, /fetch\(apiUrl\(/g)} of 2 — a fetch call was left on a relative path`);
assert('the SSE fetch site passes apiUrl(...)',
  count(stream, /fetch\(apiUrl\(/g) === 1, `found ${count(stream, /fetch\(apiUrl\(/g)} of 1 — the stream would hit the static host`);
assert('the app makes no other fetch calls',
  count(client, /fetch\(/g) === 2 && count(stream, /fetch\(/g) === 1,
  'a new raw fetch() appeared — route it through apiUrl or this check must be extended');
// And no raw fetch on an /api path survives anywhere in the two files.
assert('no fetch() call takes a bare /api path',
  !/fetch\(\s*[`'"]\/api\//.test(client) && !/fetch\(\s*[`'"]\/api\//.test(stream),
  'a fetch call still hardcodes a relative /api path');

/* ---------- the base comes from the build-time env ---------- */

const helper = read('../src/lib/apiBase.ts');
assert('the helper reads VITE_API_BASE', /import\.meta\.env\.VITE_API_BASE/.test(helper),
  'the env var name drifted — Vercel would set a variable nothing reads');
assert('apiUrl is exported', /export function apiUrl/.test(helper), 'apiUrl is not exported');

/* ---------- the deploy surface documents it ---------- */

// The env var is read at BUILD time; a reader who sets it at runtime (or in
// backend/.env) gets a silent no-op. The frontend .env.example must say so.
const envExample = read('../.env.example');
assert('.env.example documents VITE_API_BASE', /VITE_API_BASE/.test(envExample),
  'the deploy-time variable is undocumented where the frontend reads env vars');

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
