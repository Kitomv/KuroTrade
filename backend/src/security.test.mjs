// SSRF guard tests — the LLM baseUrl is user-supplied, and the backend fetches
// whatever it resolves to. A hole here turns "add a custom provider" into
// "read the cloud metadata service from the server".
//
// The IPv4-mapped IPv6 cases are regression tests for a real bypass: the URL
// parser normalises ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, so a guard
// that only recognises the dotted spelling never fires, and the prefix checks
// (fc/fd/fe80) do not match either — while connecting to that address still
// reaches 169.254.169.254 verbatim.
// Run: node --test backend/src/security.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isSafeBaseUrl, assertSafeBaseUrl, redact } from './security.js';
import { endpointFor, assertEndpointAllowed, listModels, setLLMConfig } from './llmClient.js';

/* ---------------- cloud metadata ---------------- */

test('cloud metadata endpoints are refused on every spelling', () => {
  // AWS/Azure link-local, GCP, and the IPv6 loopback they are reachable on.
  for (const u of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/',
    'https://169.254.169.254/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/',
    'http://instance-data.ec2.internal/',
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
});

test('an IPv4-mapped IPv6 literal cannot smuggle a metadata or private address', () => {
  // The URL parser rewrites the dotted tail to hex, so these arrive as
  // ::ffff:a9fe:a9fe and friends. Connecting to them reaches the IPv4 host.
  for (const u of [
    'http://[::ffff:169.254.169.254]/',
    'http://[::169.254.169.254]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::ffff:172.16.0.1]/',
    'http://[::ffff:172.31.255.255]/',
    'http://[::ffff:0.0.0.0]/',
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
});

/* ---------------- private ranges ---------------- */

test('RFC1918 and loopback IPv4 are refused, and 172.32 is not caught by mistake', () => {
  for (const u of [
    'http://10.0.0.1/', 'http://10.255.255.255/',
    'http://172.16.0.1/', 'http://172.31.255.254/',
    'http://192.168.0.1/', 'http://192.168.1.1/',
    'http://127.0.0.1/', 'http://127.0.0.1:11434/v1',
    'http://0.0.0.0/',
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
  // 172.16-31 is the private block; 172.32 is public and must stay reachable.
  assert.equal(isSafeBaseUrl('http://172.32.0.1/'), true, '172.32 is not private');
  assert.equal(isSafeBaseUrl('http://172.15.0.1/'), true, '172.15 is not private');
});

test('the extra non-RFC1918 internal ranges are refused', () => {
  // CGNAT, IETF protocol assignments, and the benchmarking block: none are
  // RFC1918, but all route inward on real networks. Their boundaries are tested
  // so an off-by-one in the range check cannot let the neighbouring public
  // address through, or block it by mistake.
  for (const u of [
    'http://100.64.0.0/', 'http://100.100.100.100/', 'http://100.127.255.255/',
    'http://192.0.0.1/', 'http://192.0.0.170/', 'http://192.0.0.255/',
    'http://198.18.0.1/', 'http://198.19.255.255/',
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
  // The neighbours are public and must stay reachable.
  for (const u of [
    'http://100.63.255.255/', 'http://100.128.0.1/',   // CGNAT edges
    'http://192.0.1.1/', 'http://192.0.2.1/',           // 192.0.0/24 edges
    'http://198.17.0.1/', 'http://198.20.0.1/',         // 198.18/15 edges
  ]) {
    assert.equal(isSafeBaseUrl(u), true, `should accept ${u}`);
  }
});

test('unique-local, link-local and loopback IPv6 are refused', () => {
  for (const u of [
    'http://[::1]/', 'http://[::]/',
    'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[fc00::1]/',
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
});

test('decimal, hex and .internal hostnames are refused', () => {
  for (const u of [
    'http://2130706433/',          // 127.0.0.1 as an integer
    'http://0x7f000001/',          // 127.0.0.1 as hex
    'http://foo.internal/',
    'http://FOO.INTERNAL/',        // casing must not matter
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
});

/* ---------------- scheme and credentials ---------------- */

test('non-http schemes and embedded credentials are refused', () => {
  for (const u of [
    'file:///etc/passwd',
    'gopher://evil/',
    'ftp://evil/',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'https://user:pass@api.example.com/v1',
    'https://token@169.254.169.254/',
  ]) {
    assert.equal(isSafeBaseUrl(u), false, `should refuse ${u}`);
  }
});

test('malformed input is refused, never thrown', () => {
  for (const bad of ['', null, undefined, 0, 42, {}, [], 'not a url', 'http://', ':::']) {
    assert.equal(isSafeBaseUrl(bad), false, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a path long enough to be an abuse vector is refused', () => {
  assert.equal(isSafeBaseUrl(`https://api.example.com/${'a'.repeat(600)}`), false);
});

/* ---------------- must NOT over-block ---------------- */

test('legitimate public endpoints stay reachable', () => {
  for (const u of [
    'https://api.openai.com/v1',
    'https://api.anthropic.com/v1',
    'https://api.9router.com/v1',
    'https://api.deepseek.com/v1',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'http://localhost:11434/v1',          // a local Ollama is a supported setup
    'https://[2606:4700:4700::1111]/v1',  // public IPv6
  ]) {
    assert.equal(isSafeBaseUrl(u), true, `should accept ${u}`);
  }
});

test('loopback by IP is refused while the hostname form is allowed — an inconsistency', () => {
  // Documenting the current behaviour, not endorsing it. The code comment says
  // "Localhost is allowed for the configured local 9router/Ollama setup", and
  // the hostname form does pass. But the 127.0.0.0/8 check rejects the numeric
  // spelling of the same host, so `http://127.0.0.1:11434/v1` — a valid Ollama
  // address — is refused. Whoever configures a local provider must write
  // "localhost". Widening this is a deliberate security decision, not a fix to
  // make silently; this test pins the behaviour so a change is visible.
  assert.equal(isSafeBaseUrl('http://localhost:11434/v1'), true, 'hostname form is allowed');
  assert.equal(isSafeBaseUrl('http://127.0.0.1:11434/v1'), false, 'IP form is refused');
  assert.equal(isSafeBaseUrl('http://127.0.0.1:8080/v1'), false, 'and so is any other loopback port');
});

/* ---------------- endpointFor: the guard in context ---------------- */

test('endpointFor refuses a private or metadata baseUrl for every provider', () => {
  for (const provider of ['custom', 'azure', '9router', 'ollama', 'bedrock']) {
    for (const bad of [
      'http://169.254.169.254/v1',
      'http://[::ffff:169.254.169.254]/v1',
      'http://10.0.0.5:8080/v1',
      'http://192.168.1.1/v1',
      'file:///etc/passwd',
    ]) {
      assert.throws(
        () => endpointFor(provider, bad),
        /tidak diizinkan/,
        `${provider} + ${bad} must be refused`,
      );
    }
  }
});

test('a preset provider ignores the user baseUrl entirely', () => {
  // A stored baseUrl must never redirect a provider with a known host —
  // otherwise changing one field in Settings sends the API key elsewhere.
  for (const provider of ['openai', 'deepseek', 'gemini', 'openrouter', 'xai', 'qwen', 'glm', 'minimax']) {
    const resolved = endpointFor(provider, 'http://169.254.169.254/');
    assert.ok(!resolved.includes('169.254'), `${provider} must not be redirected`);
    assert.ok(resolved.startsWith('https://'), `${provider} must stay on its preset host`);
  }
});

test('anthropic is pinned to its own endpoint regardless of baseUrl', () => {
  assert.equal(endpointFor('anthropic', 'http://169.254.169.254/v1'), 'https://api.anthropic.com/v1/messages');
  assert.equal(endpointFor('anthropic', undefined), 'https://api.anthropic.com/v1/messages');
});

test('a valid custom baseUrl gets /chat/completions appended exactly once', () => {
  assert.equal(endpointFor('custom', 'https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  // Already-suffixed and trailing-slash forms must not double up.
  assert.equal(endpointFor('custom', 'https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('custom', 'https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('custom', 'https://api.example.com/v1///'), 'https://api.example.com/v1/chat/completions');
});

test('a custom provider with no baseUrl falls back to OpenAI rather than throwing', () => {
  assert.equal(endpointFor('custom', ''), 'https://api.openai.com/v1/chat/completions');
  assert.equal(endpointFor('custom', undefined), 'https://api.openai.com/v1/chat/completions');
});

test('ollama and bedrock accept a localhost baseUrl (the local-gateway setup)', () => {
  assert.equal(endpointFor('ollama', 'http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(endpointFor('bedrock', 'http://localhost:8080/v1'), 'http://localhost:8080/v1/chat/completions');
});

/* ---------------- assertSafeBaseUrl: the DNS-resolving guard ----------------
 *
 * Everything above is a SYNTAX check: it sees the hostname as written and never
 * what that hostname resolves to. `127.0.0.1.nip.io` is an ordinary-looking
 * name that resolves to loopback, so a user could store one as their LLM
 * baseUrl and have the server POST their Bearer key to an address they chose.
 * These are the regression tests for that hole — they need live DNS, which is
 * why they are kept apart from the offline checks above.
 */

test('a hostname that resolves to loopback is refused', async () => {
  for (const u of [
    'http://127.0.0.1.nip.io/v1',
    'http://localhost.nip.io/v1',
  ]) {
    await assert.rejects(assertSafeBaseUrl(u), /tidak diizinkan/, `should refuse ${u}`);
  }
});

test('a hostname that resolves to cloud metadata or the LAN is refused', async () => {
  for (const u of [
    'http://169.254.169.254.nip.io/v1',
    'http://metadata.google.internal.nip.io/v1',
    'http://10.1.2.3.sslip.io/v1',
    'http://192.168.1.1.sslip.io/v1',
  ]) {
    await assert.rejects(assertSafeBaseUrl(u), /tidak diizinkan/, `should refuse ${u}`);
  }
});

test('a hostname that does not resolve fails closed rather than proceeding', async () => {
  // No address to prove safe, so the request does not happen. `.invalid` is
  // reserved by RFC 2606 and can never be registered.
  await assert.rejects(
    assertSafeBaseUrl('http://does-not-exist.invalid/v1'),
    /tidak dapat diresolve/,
  );
});

test('the local providers may resolve to loopback — that is the setup they exist for', async () => {
  await assert.doesNotReject(assertSafeBaseUrl('http://localhost:11434/v1', { allowLoopback: true }));
  // The exception is loopback and nothing else: ollama must not become a
  // tunnel to the LAN or to the metadata service.
  await assert.rejects(
    assertSafeBaseUrl('http://10.1.2.3.sslip.io/v1', { allowLoopback: true }),
    /tidak diizinkan/,
  );
  await assert.rejects(
    assertSafeBaseUrl('http://169.254.169.254.nip.io/v1', { allowLoopback: true }),
    /tidak diizinkan/,
  );
});

test('assertEndpointAllowed keeps the DNS check but skips it for fixed hosts', async () => {
  // The one that carries the API key. A rebound name must never get there.
  await assert.rejects(
    assertEndpointAllowed('custom', 'http://127.0.0.1.nip.io:9999/v1'),
    /tidak diizinkan/,
  );
  // A provider with a preset host resolves no user-supplied name, so there is
  // nothing to resolve — it must not be slowed down by a DNS round trip.
  assert.equal(
    await assertEndpointAllowed('openai', undefined),
    'https://api.openai.com/v1/chat/completions',
  );
  // Local providers keep working end to end.
  assert.equal(
    await assertEndpointAllowed('ollama', 'http://localhost:11434/v1'),
    'http://localhost:11434/v1/chat/completions',
  );
});

test('a redirect cannot walk past the guard — the key stops at hop one', async () => {
  const reached = [];
  // The guard checks ONE url. `fetch` follows up to 20 more by default, and
  // re-sends the Authorization header to each one. A public origin that answers
  // `302 location: http://169.254.169.254/…` therefore reached the metadata
  // service with the user's key attached — verified against the pre-fix code,
  // where this same request returned status 200 from the internal host.
  //
  // A loopback origin is used here because it is legitimately admitted for the
  // local providers, which is the one setup where hop one passes on purpose.
  const internal = createServer((req, res) => {
    reached.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const internalPort = internal.address().port;

  const origin = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/latest/meta-data/` });
    res.end();
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;

  try {
    await assert.rejects(
      listModels(`redir_${Date.now()}`, {
        provider: 'ollama',
        baseUrl: `http://localhost:${originPort}/v1`,
        apiKey: 'sk-victim-1234567890',
      }),
      /HTTP 302/,
      'a redirect must be reported, not followed',
    );
    assert.deepEqual(reached, [], 'the internal host must never be reached');

    // Counterfactual, so the assertion above cannot pass vacuously: with Node's
    // default redirect-following the very same origin DOES reach internal.
    const followed = await fetch(`http://localhost:${originPort}/v1/models`, {
      headers: { Authorization: 'Bearer sk-victim-1234567890' },
    });
    assert.equal(followed.status, 200, 'sanity: the origin does redirect to internal');
    assert.equal(reached.length, 1, 'default fetch follows the redirect — so the guard was the only barrier');
  } finally {
    origin.close();
    internal.close();
  }
});

test('a first save with a blank apiKey does not adopt the operator key', () => {
  // "Blank means keep what's stored" must mean the USER's stored key. Falling
  // back to the env default copied the operator's shared key into an
  // attacker's tenant file and then POSTed it to whatever baseUrl they named.
  const operatorKey = process.env.ROUTER_API_KEY;
  process.env.ROUTER_API_KEY = 'sk-OPERATOR-SECRET-000111222333';
  try {
    // Re-import so module-level `defaultConfigs` picks up the new env value.
    const uid = `blank_${Date.now()}`;
    const cfg = setLLMConfig(uid, [{
      provider: 'custom', model: 'x', baseUrl: 'https://example.invalid/v1', apiKey: '',
    }]);
    assert.equal(cfg.hasKey, false, 'an identified user must not inherit the operator key');
    assert.equal(cfg.maskedKey, '', 'and must not be handed a masked fragment of it');
  } finally {
    if (operatorKey === undefined) delete process.env.ROUTER_API_KEY;
    else process.env.ROUTER_API_KEY = operatorKey;
  }
});

test('a later save still keeps that user\'s own key when the field is blank', () => {
  const uid = `keepown_${Date.now()}`;
  setLLMConfig(uid, [{ provider: 'custom', model: 'x', baseUrl: 'https://a.example/v1', apiKey: 'sk-mine-1234567890' }]);
  const cfg = setLLMConfig(uid, [{ provider: 'custom', model: 'y', baseUrl: 'https://a.example/v1', apiKey: '' }]);
  assert.equal(cfg.hasKey, true, 'blank means keep MINE, which is the feature this path exists for');
  assert.equal(cfg.model, 'y', 'and the rest of the row still updates');
});

test('a stored key does not follow a baseUrl change to a new host', () => {
  // Blank-key-means-keep is for "I edited the model", NOT for "I changed the
  // host". Carrying the key across a host change hands it to whoever named the
  // new host, and the admin password-reset path makes that reachable: reset a
  // password, log in as that account, re-point its baseUrl with a blank key,
  // and the next LLM call sends `Authorization: Bearer <victim key>` to the
  // attacker's server. GET /api/llm/config only ever showed it masked, so the
  // proxy is what discloses the full value.
  const uid = `repoint_${Date.now()}`;
  setLLMConfig(uid, [{ provider: 'custom', model: 'x', baseUrl: 'https://real.example/v1', apiKey: 'sk-mine-1234567890' }]);
  const cfg = setLLMConfig(uid, [{ provider: 'custom', model: 'x', baseUrl: 'https://attacker.example/v1' }]);
  assert.equal(cfg.hasKey, false, 'the key must not be carried to a host its owner did not choose');
  assert.equal(cfg.maskedKey, '', 'and must not come back as a masked fragment either');
});

test('a key survives an edit that keeps the same origin', () => {
  // Same host, different path/version — the legitimate "keep my key" case.
  const uid = `sameorigin_${Date.now()}`;
  setLLMConfig(uid, [{ provider: 'custom', model: 'x', baseUrl: 'https://a.example/v1', apiKey: 'sk-mine-1234567890' }]);
  const cfg = setLLMConfig(uid, [{ provider: 'custom', model: 'x', baseUrl: 'https://a.example/v2' }]);
  assert.equal(cfg.hasKey, true, 'an origin-preserving edit must still keep the key');
});

test('a key does not follow a provider change', () => {
  // Both presets carry an empty baseUrl, so only the provider distinguishes
  // them — and an OpenAI key must not be re-sent to Anthropic.
  const uid = `reprov_${Date.now()}`;
  setLLMConfig(uid, [{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-mine-1234567890' }]);
  const cfg = setLLMConfig(uid, [{ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }]);
  assert.equal(cfg.hasKey, false, 'the key must not follow a provider change');
});

/* ---------------- spend ---------------- */

test('the provider stack is capped — it multiplies every paid request', () => {
  // The hedge ladder admits one candidate per stack entry and abandons none,
  // so stack length IS the request count for a single call. Measured before
  // this cap: a 40-entry body produced 26 concurrent paid requests. The body
  // comes straight off the wire, so without a cap the caller sets the bill.
  const uid = `cap_${Date.now()}`;
  const many = Array.from({ length: 40 }, () => ({
    provider: 'custom', model: 'm', apiKey: 'sk-key-abcdefghij', baseUrl: 'https://example.com/v1',
  }));
  assert.equal(setLLMConfig(uid, many).entries.length, 4, 'an oversized stack must be truncated, not stored');

  // And a normal save is untouched — the cap must not quietly eat entries.
  const single = `capone_${Date.now()}`;
  assert.equal(setLLMConfig(single, [{ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-key-abcdefghij' }]).entries.length, 1);
  assert.equal(setLLMConfig(single, [{ provider: 'openai' }, { provider: 'anthropic' }]).entries.length, 2);
});

/* ---------------- redact: what reaches the logs ---------------- */

test('redact catches every provider key format this app accepts', () => {
  // The stem rule alone (`sk|key|token|secret`) missed three vendors that are
  // selectable providers here, so an upstream error echoing them back would
  // have printed the user's key to the server log verbatim.
  const hex64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  for (const [label, key] of Object.entries({
    'anthropic': 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
    'openai project': 'sk-proj-abcdefghijklmnopqrstuvwxyz1234',
    'openrouter': 'sk-or-v1-0123456789abcdef0123456789abcdef',
    'gemini': 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'xai': 'xai-abcdefghijklmnopqrstuvwxyz0123',
    'aws access key': 'AKIAIOSFODNN7EXAMPLE',
    'bearer': 'Bearer abcdefghijklmnop1234567890XYZ',
    'raw hex private key': hex64,
    '0x-prefixed key': `0x${hex64}`,
  })) {
    const out = redact(`upstream rejected key=${key} (${label})`);
    assert.ok(!out.includes(key), `${label} leaked: ${out}`);
  }
});

test('redact leaves a transaction hash readable — the executor logs depend on it', () => {
  // A 64-hex value is indistinguishable from a txHash. Over-redacting here
  // would gut exactly the crash-recovery logs the journal exists to produce,
  // so the hex rule must require a key-ish word in front of it.
  const tx = `0x${'b'.repeat(64)}`;
  assert.equal(redact(`sent txHash=${tx}`), `sent txHash=${tx}`);
  assert.equal(redact(tx), tx, 'a bare hash in a JSON blob stays intact');
});
