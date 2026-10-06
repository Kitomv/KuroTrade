// Universal Cloud LLM Provider Client — multi-provider with fallback chain
// Native fetch, zero external SDK deps. Supports:
//  - Fallback chain: primary provider fails → try next (reliability)
//  - Role routing: Bull/Bear/Lead can target different providers (optional)
// `ponytail:` swap to SDK-based clients if a provider needs advanced features.
// Importers/callers: server.js (/api/llm/config GET/POST), aiAgent.js (callLLM), persistence.js via provider
// Affected API: GET/POST /api/llm/config (per-user), autopilot LLM calls via callLLM()
// Data schema: LLMProviderEntry[] per user — { key, provider, model, baseUrl, role }
// User instruction: "setiap server restart peruser harus config llmnya masing masing lagi kah?" → persist LLM config per user
import { registerStateProvider, loadUserState, touch } from './persistence.js';
import { isSafeBaseUrl, assertSafeBaseUrl } from './security.js';

const PROVIDERS = [
  '9router', 'anthropic', 'openai', 'deepseek', 'openrouter', 'custom',
  'gemini', 'xai', 'qwen', 'glm', 'minimax', 'ollama', 'azure', 'bedrock',
];

// Endpoint presets for OpenAI-compatible providers. `custom`/`9router`/`azure`
// use the user-supplied baseUrl (Azure: https://<res>.openai.azure.com/openai/deployments/<dep>).
const ENDPOINT_PRESETS = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  minimax: 'https://api.minimax.chat/v1',
  ollama: 'http://localhost:11434/v1',
  bedrock: 'http://localhost:8080/v1', // bedrock-access-gateway / LiteLLM proxy
};

// An origin that passed the guard can still answer `302 location: http://169.254.169.254/…`,
// and `fetch` follows that — re-sending the Authorization header to a host the
// guard never looked at. Every outbound call therefore opts out of redirects;
// a redirect is just a second, unchecked baseUrl.
const NO_REDIRECT = { redirect: 'manual' };

// Providers whose endpoint is meant to sit on this machine. They are the only
// ones `assertEndpointAllowed` lets resolve to loopback — see the note there.
const LOCAL_PROVIDERS = new Set(['ollama', 'bedrock']);

// The hedge ladder admits the next candidate every `hedgeDelayMs` and abandons
// none, so one callLLM costs up to ONE PAID REQUEST PER ENTRY. Measured: a
// 40-entry stack fired 26 concurrent requests for a single analysis. Since
// POST /api/llm/config takes the array straight from the request body, the
// stack length is caller-controlled, so it is also a spend multiplier. Four is
// enough for primary + fallbacks; nothing here needs more.
const MAX_PROVIDER_STACK = 4;

// Per-user provider config stacks; global default from env.
// Each entry: { key, provider, model, baseUrl, role?, deepModel? }
let defaultConfigs = [
  {
    key: process.env.ROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
    provider: '9router',
    model: 'claude-3-5-sonnet-20241022',
    baseUrl: 'https://api.9router.com/v1',
    role: null,
  },
];

// In-memory user overrides keyed by userId, hydrated from persisted state on
// first load so a server restart keeps each user's provider stack. The
// persistence provider below writes llmConfigs back to the per-user JSON.
const userConfigs = new Map(); // userId -> configs[]

// Hydrate user LLM config from persisted state (idempotent).
function ensureLoaded(userId) {
  if (!userId || userConfigs.has(userId)) return;
  const saved = loadUserState(userId);
  if (Array.isArray(saved?.llmConfigs) && saved.llmConfigs.length > 0) {
    userConfigs.set(userId, saved.llmConfigs);
  }
}

// Persistence provider — llmClient writes its slice into the per-user JSON.
// CRITICAL: never stub a user's config with `defaultConfigs` here. This provider
// runs on EVERY flush, and returning defaultConfigs for a user who has saved
// entries (but whose map wasn't hydrated yet) would overwrite their on-disk
// stack with the env default → "LLM config reset after restart". hydrate first;
// only publish a slice when the user actually has one.
registerStateProvider((userId) => {
  if (!userId) return null;
  ensureLoaded(userId);
  if (!userConfigs.has(userId)) return null; // no per-user config → don't write one
  return { llmConfigs: userConfigs.get(userId) };
});

export function getLLMConfig(userId = null) {
  ensureLoaded(userId);
  // A user with no saved config falls back to `defaultConfigs`, which is seeded
  // from the process env. That fallback is for the ANONYMOUS/no-user case only —
  // handing it to an identified account would let any user who never configured
  // an LLM spend the operator's key, and hand the UI a masked fragment of it.
  const isIdentified = Boolean(userId);
  const cfg = userId && userConfigs.has(userId) ? userConfigs.get(userId)
    : (isIdentified ? [] : defaultConfigs);
  const activeProviders = cfg.filter((c) => c.key && c.key.trim().length > 3);
  const masked = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');
  return {
    provider: activeProviders[0]?.provider ?? 'unknown',
    providers: activeProviders.map((c) => c.provider),
    models: activeProviders.map((c) => c.model),
    model: activeProviders[0]?.model ?? '',
    baseUrl: activeProviders[0]?.baseUrl ?? '',
    hasKey: activeProviders.length > 0,
    maskedKey: masked(activeProviders[0]?.key),
    // Full stack (keys masked) so the UI can edit every entry, not just the first.
    entries: cfg.map((c) => ({
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl ?? '',
      role: c.role ?? null,
      hasKey: Boolean(c.key && c.key.trim().length > 3),
      maskedKey: masked(c.key),
    })),
  };
}

/** The origin a baseUrl names, or '' when it names nothing usable.
 *  Two edits are the "same endpoint" only when this matches. */
function originOf(baseUrl) {
  if (!baseUrl) return '';
  try { return new URL(baseUrl).origin; } catch { return String(baseUrl); }
}

/** Set per-user provider stack. Accepts a single object (legacy) or an array (multi-LLM). */
export function setLLMConfig(userId, value) {
  ensureLoaded(userId);
  const arr = (Array.isArray(value) ? value : [value]).slice(0, MAX_PROVIDER_STACK);
  // Blank apiKey means "keep what this user already had" — and what this user
  // already had is NOTHING. It must not fall back to `defaultConfigs`, or the
  // first save for an identified account adopts the operator's shared key and
  // then POSTs it to whatever baseUrl that save named.
  const prev = userId ? (userConfigs.get(userId) ?? []) : defaultConfigs;
  const configs = arr.map((c, i) => {
    const provider = PROVIDERS.includes(c.provider) ? c.provider : '9router';
    const baseUrl = c.baseUrl ?? '';
    // A stored key is carried across an edit only when that edit keeps the SAME
    // provider AND the same origin. Blank-key-means-keep exists for "I changed
    // the model", not for "I changed the host": carrying the key across a host
    // change hands it to whoever named the new host, and the admin password
    // reset makes that reachable (reset → log in as the account → re-point its
    // baseUrl with a blank key → the next call sends `Bearer <that key>` to the
    // attacker's server). GET /api/llm/config only ever showed the key masked,
    // so that call is what discloses it. Fail closed: any identity change drops
    // the key and the user must re-enter it.
    const prevEntry = prev[i];
    const sameIdentity = Boolean(prevEntry)
      && (PROVIDERS.includes(prevEntry.provider) ? prevEntry.provider : '9router') === provider
      && originOf(prevEntry.baseUrl ?? '') === originOf(baseUrl);
    const prevKey = sameIdentity ? (prevEntry.key ?? '') : '';
    return {
      key: (c.apiKey ?? c.key ?? '').trim() || prevKey,
      provider,
      model: c.model || 'claude-3-5-sonnet-20241022',
      baseUrl,
      role: c.role ?? null, // 'bull' | 'bear' | 'lead' | null (default)
    };
  });
  if (userId) {
    userConfigs.set(userId, configs);
    touch(userId); // persist llmConfigs via the provider above
  } else defaultConfigs = configs;
  return getLLMConfig(userId);
}

/** Resolve a provider endpoint, validating any user-supplied baseUrl first so
 *  the server can never be pointed at cloud metadata / private IPs (SSRF).
 *
 *  Exported so the SSRF guard can be tested directly. This is a security
 *  boundary: asserting it through a mocked fetch would only prove the mock
 *  behaves, not that the guard rejects a metadata endpoint. */
export function endpointFor(provider, baseUrl) {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  // Providers with a fixed host: ignore user baseUrl entirely (prevents a
  // stored baseUrl from redirecting a preset provider to an arbitrary host).
  const preset = ENDPOINT_PRESETS[provider];
  if (preset && provider !== 'azure' && provider !== '9router') {
    const base = (baseUrl && (provider === 'ollama' || provider === 'bedrock') ? baseUrl : preset).replace(/\/+$/, '');
    if (!isSafeBaseUrl(base)) throw new Error('baseUrl tidak diizinkan (SSRF guard)');
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }
  // custom / azure / 9router: user-supplied base must pass the SSRF guard.
  const base = (baseUrl || (provider === '9router' ? 'https://api.9router.com/v1' : '')).replace(/\/+$/, '');
  if (!base) return 'https://api.openai.com/v1/chat/completions';
  if (!isSafeBaseUrl(base)) throw new Error('baseUrl tidak diizinkan (SSRF guard)');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/**
 * Same as `endpointFor`, but resolves the hostname first.
 *
 * `endpointFor` is sync and only sees the hostname as written, so it cannot
 * stop `127.0.0.1.nip.io`. Every fetch that carries a Bearer key goes through
 * THIS one instead — an SSRF that reaches a loopback service would otherwise
 * hand that host the user's API key in the Authorization header.
 */
export async function assertEndpointAllowed(provider, baseUrl) {
  const endpoint = endpointFor(provider, baseUrl);
  // The test is whether the CALLER supplied this host, not which provider
  // name it came under: `ollama` and `bedrock` are preset providers that still
  // accept a user baseUrl, so keying off the name would skip the very case
  // (`ollama` + rebound hostname) that needs checking. Keying off `baseUrl`
  // skips the DNS round trip only when the host is genuinely ours.
  if (!baseUrl) return endpoint;
  // These two ARE the local setup (a model runtime and a gateway proxy on the
  // same box), so loopback is their intended target — the same reason
  // `isSafeBaseUrl` allows localhost. The exception is the loopback interface
  // alone: LAN, link-local and cloud metadata stay blocked even for them, or
  // picking `ollama` would hand an attacker a tunnel to the private network.
  const allowLoopback = LOCAL_PROVIDERS.has(provider);
  await assertSafeBaseUrl(endpoint, { allowLoopback });
  return endpoint;
}

async function callAnthropic(entry, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': entry.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: entry.model,
      temperature: body.temperature,
      stream: false,
      system: body.systemPrompt,
      messages: [{ role: 'user', content: body.userPrompt }],
    }),
    signal: AbortSignal.timeout(entry.timeoutMs ?? 30_000),
    ...NO_REDIRECT,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const text = await res.text();
  const data = parseLLMResponse(text, 'anthropic');
  return data.content?.[0]?.text ?? data.choices?.[0]?.message?.content ?? null;
}

/**
 * Tolerant LLM response parser. Some OpenAI-compatible routers (e.g. a local
 * 9router) reply with SSE/NDJSON even when `stream:false` was requested, which
 * makes `res.json()` throw "Unexpected non-whitespace character after JSON".
 * Order: plain JSON → SSE `data:` lines → first balanced {...} object.
 */
function parseLLMResponse(text, provider = 'llm') {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error(`${provider}: empty response body`);
  // 1. Plain JSON
  try { return JSON.parse(raw); } catch {}
  // 2. SSE / NDJSON — collect `data: {...}` payloads (skip `[DONE]`)
  const sseLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (sseLines.length > 0) {
    let last = null;
    for (const line of sseLines) {
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { last = JSON.parse(payload); } catch {}
    }
    if (last) return last;
  }
  // 3. First balanced {...} object in the text
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  // The body is NOT echoed. This throw is surfaced to the browser by `wrap`,
  // and an unparseable body from a baseUrl the caller controls is whatever
  // that host chose to return — which, before the SSRF guard, could be the
  // body of a host-local service. Say it failed; keep the detail server-side.
  throw new Error(`${provider}: unparseable response`);
}

async function callOpenAICompat(entry, body) {
  // The async guard, not `endpointFor`: this is the path that attaches
  // `Authorization: Bearer ${entry.key}`, so it must resolve DNS before the
  // fetch. Anything that reaches this function with a user-supplied hostname
  // that points inward must not get the key.
  const endpoint = await assertEndpointAllowed(entry.provider, entry.baseUrl);
  const timeoutMs = entry.timeoutMs ?? 30_000;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${entry.key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'DexScreener AI Trading Dashboard',
    },
    body: JSON.stringify({
      model: entry.model,
      temperature: body.temperature,
      stream: false,
      // Agents only need a score + a few bullets. Capping output stops slow
      // routers from spending seconds generating prose the parser discards.
      max_tokens: body.maxTokens ?? 600,
      messages: [
        { role: 'system', content: body.systemPrompt },
        { role: 'user', content: body.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
    ...NO_REDIRECT,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${entry.provider.toUpperCase()} ${res.status}: ${errText.slice(0, 200)}`);
  }
  const text = await res.text();
  const data = parseLLMResponse(text, entry.provider);
  return data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? null;
}

function callLLMProvider(entry, body) {
  return entry.provider === 'anthropic' ? callAnthropic(entry, body) : callOpenAICompat(entry, body);
}

/**
 * Call LLM with a hedged fallback chain.
 *
 * The old loop awaited each provider to its full 30-90s timeout before trying
 * the next one, so a queued router model froze the whole autopilot tick. Now:
 *   - the primary starts immediately;
 *   - if it has not answered within `hedgeDelayMs`, the next candidate starts
 *     in parallel (a hedge);
 *   - the first non-empty answer wins and the rest are abandoned.
 * Behaviour on total failure is unchanged: throws the last error so callers
 * still fall back to the deterministic engine.
 */
export async function callLLM({ systemPrompt, userPrompt, temperature = 0.2, role = null, userId = null, hedgeDelayMs = 8_000, timeoutMs = null }) {
  ensureLoaded(userId);
  // Same rule as getLLMConfig: an identified user with no saved stack gets none.
  // Falling back to the env default here would spend the operator's key on
  // autopilot scans for an account that never asked for one.
  const stack = userId && userConfigs.has(userId) ? userConfigs.get(userId)
    : (userId ? [] : defaultConfigs);
  // `timeoutMs` from the autopilot config overrides each entry's own setting so
  // the UI knob actually takes effect without editing every provider row.
  const candidates = stack
    .filter((c) => c.key && c.key.trim().length > 3)
    .map((c) => (timeoutMs ? { ...c, timeoutMs } : c));
  if (candidates.length === 0) return null;

  const ordered = role
    ? [...candidates.filter((c) => c.role === role), ...candidates.filter((c) => c.role !== role)]
    : candidates;

  const body = { systemPrompt, userPrompt, temperature };
  const failures = [];

  // An attempt always resolves to a result. Never leave a rejected provider
  // promise behind: a hedged request may outlive this function after another
  // provider wins, and Node treats its later rejection as a process-fatal error.
  const attempt = (entry) => callLLMProvider(entry, body)
    .then((text) => text
      ? { ok: true, text, entry }
      : { ok: false, error: new Error(`${entry.provider}: empty response`), entry })
    .catch((e) => {
      const msg = String(e?.message ?? e);
      const error = msg.includes('aborted due to timeout')
        ? new Error(`${entry.provider}/${entry.model}: timeout setelah ${(entry.timeoutMs ?? 30_000) / 1000}s (model lambat/antre di router — coba model lain atau naikkan timeout)`)
        : e;
      failures.push(error);
      console.warn(`[llm] ${entry.provider}/${entry.model} failed: ${error.message.slice(0, 160)}`);
      return { ok: false, error, entry };
    });

  // Hedged ladder: start the next candidate only when the active candidates
  // have been slow for `hedgeDelayMs`. The timer resolves a sentinel instead
  // of rejecting, so an abandoned timer can never crash Node later.
  const active = [];
  let lastErr = null;
  for (let i = 0; i < ordered.length; i++) {
    const state = { settled: false, promise: null };
    state.promise = attempt(ordered[i]).then((result) => {
      state.settled = true;
      return result;
    });
    active.push(state);

    const isLast = i === ordered.length - 1;
    const pending = active.filter((x) => !x.settled).map((x) => x.promise);
    const hedge = isLast
      ? null
      : new Promise((resolve) => setTimeout(() => resolve({ hedge: true }), hedgeDelayMs));
    const result = await Promise.race(hedge ? [...pending, hedge] : pending);
    if (result.hedge) continue; // current candidates are slow; admit fallback
    if (result.ok) return result.text;
    lastErr = result.error;
  }

  // All candidates were admitted. Promise.any waits for the first successful
  // result while safely observing every failure.
  try {
    return await Promise.any(active.map(({ promise }) => promise.then((result) => {
      if (result.ok) return result.text;
      throw result.error;
    })));
  } catch {
    throw lastErr ?? failures[failures.length - 1] ?? new Error('Semua kandidat LLM gagal');
  }
}

/**
 * List model IDs from an OpenAI-compatible `/models` endpoint. `overrides`
 * lets the settings modal preview a not-yet-saved provider/baseUrl/key.
 */
export async function listModels(userId, overrides = {}) {
  ensureLoaded(userId);
  const stack = userId && userConfigs.has(userId) ? userConfigs.get(userId)
    : (userId ? [] : defaultConfigs);
  const stored = stack.find((c) => c.key) ?? stack[0] ?? {};
  const provider = overrides.provider ?? stored.provider ?? '9router';
  const baseUrl = overrides.baseUrl ?? stored.baseUrl ?? '';
  const apiKey = overrides.apiKey?.trim() || stored.key || '';
  if (!apiKey) throw new Error('API key belum diisi');

  const base = (baseUrl || ENDPOINT_PRESETS[provider] || 'https://api.openai.com/v1').replace(/\/+$/, '');
  // Same loopback exception the chat path grants, or "list models" on a local
  // Ollama would be refused while the chat that follows it succeeds.
  await assertSafeBaseUrl(base, { allowLoopback: LOCAL_PROVIDERS.has(provider) });
  const url = `${base}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    ...NO_REDIRECT,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = parseLLMResponse(text, provider); } catch (e) { throw new Error(e.message); }
  const ids = (data.data ?? data.models ?? [])
    .map((m) => (typeof m === 'string' ? m : m.id ?? m.name ?? m.model))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * Probe a provider entry without running a full analysis. Always verifies the
 * actual chat path (not just /models) so a queued/slow model is caught here
 * instead of crashing the first autopilot tick. Returns structured result.
 */
export async function testConnection(userId, entry = {}) {
  const started = Date.now();
  const stack = userId && userConfigs.has(userId) ? userConfigs.get(userId)
    : (userId ? [] : defaultConfigs);
  const stored = stack.find((c) => c.key) ?? stack[0] ?? {};
  const merged = {
    provider: entry.provider ?? stored.provider ?? '9router',
    model: entry.model ?? stored.model ?? 'gpt-4o-mini',
    baseUrl: entry.baseUrl ?? stored.baseUrl ?? '',
    key: entry.apiKey?.trim() || stored.key || '',
  };
  if (!merged.key) return { ok: false, status: 0, latencyMs: Date.now() - started, error: 'API key belum diisi' };

  // 1) List models (fast diagnostic + fills the combo box).
  let modelCount = 0;
  let modelsList = [];
  let modelsErr = '';
  try {
    const models = await listModels(userId, entry);
    modelCount = models.length;
    modelsList = models.slice(0, 50);
  } catch (e) {
    modelsErr = String(e?.message ?? e).slice(0, 200);
  }

  // 2) Tiny real chat completion with the actual model — the true gate.
  //    Bounded to 25s so the test button responds fast even on a queued model.
  try {
    const text = await callLLMProvider({ ...merged, timeoutMs: 25_000 }, { systemPrompt: 'Reply with OK.', userPrompt: 'ping', temperature: 0 });
    return {
      ok: true,
      via: 'chat',
      latencyMs: Date.now() - started,
      modelCount,
      models: modelsList.length ? modelsList : undefined,
      sample: String(text ?? '').slice(0, 60),
    };
  } catch (chatErr) {
    const ce = String(chatErr?.message ?? chatErr).slice(0, 400);
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      modelCount,
      error: ce,
      modelsError: modelsErr || undefined,
      models: modelsList.length ? modelsList : undefined,
    };
  }
}
