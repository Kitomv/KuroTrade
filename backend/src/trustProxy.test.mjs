// The deployed app sits behind Railway's edge, which delivers exactly two
// X-Forwarded-For entries: the real client leftmost, one internal hop
// rightmost. `trust proxy` must skip that internal hop, or `req.ip` is the
// same address for every visitor — ten failed logins from anyone then locks
// the login route for everyone (probed live: the rightmost entry was
// identical across two different client networks).
//
// This spawns the real server and simulates the edge's header shape: two
// clients behind one shared internal hop. The guard must keep the buckets
// separate — a shared bucket shows up as client B being 429'd by client A's
// failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 39119;
const SHARED_HOP = '203.0.113.99'; // the internal hop the platform appends
const CLIENT_A = '198.51.100.7';
const CLIENT_B = '198.51.100.8';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const login = (username, xff) => fetch(`http://127.0.0.1:${PORT}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
  body: JSON.stringify({ username, password: 'wrong-password' }),
}).then((res) => res.status);

test('login limits bucket per client behind a two-entry edge XFF', async () => {
  const backendDir = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'kuro-trust-proxy-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(PORT), PERSIST_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        up = res.ok;
      } catch { /* not listening yet */ }
      if (!up) await sleep(250);
    }
    if (!up) assert.fail(`server did not boot within 10s: ${stderr.slice(-400)}`);

    // Client A fails ten times; the eleventh request trips the guard.
    for (let i = 0; i < 10; i++) {
      assert.equal(await login('edge-probe-a', `${CLIENT_A}, ${SHARED_HOP}`), 401,
        `attempt ${i + 1} from A should be a plain 401`);
    }
    assert.equal(await login('edge-probe-a', `${CLIENT_A}, ${SHARED_HOP}`), 429,
      'client A is now blocked');

    // Client B arrives through the SAME internal hop. If req.ip resolved to
    // the hop (trust proxy too low), A's failures would have 429'd B too.
    assert.equal(await login('edge-probe-b', `${CLIENT_B}, ${SHARED_HOP}`), 401,
      'client B must have its own bucket — a shared bucket means one attacker locks out every visitor');
  } finally {
    child.kill();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch { /* Windows may hold the JSON files briefly; the temp dir is disposable */ }
  }
});
