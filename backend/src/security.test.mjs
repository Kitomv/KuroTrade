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
import { isSafeBaseUrl } from './security.js';
import { endpointFor } from './llmClient.js';

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
