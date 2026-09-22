# Code Review — Autopilot + LLM Performance Changes

**Reviewed:** 2026-09-22 (local review of `backend/src/aiAgent.js`, `backend/src/llmClient.js`, `frontend/src/pages/Agents.tsx`, `frontend/src/api/client.ts`)
**Scope:** "improve auto pilot" + "improve kinerja llm"

## Findings

### CRITICAL — `LLM_JSON_PARSE` reference without declaration
- File: `backend/src/aiAgent.js` (declaration was dropped at ~line 248)
- Reference sites: lines 340, 355, 422
- **Issue:** an earlier edit dropped the `const LLM_JSON_PARSE = ...` helper but kept 3 call sites. `node --check` passes (syntax-only); at runtime the first LLM response parse throws `ReferenceError`, silently breaking all LLM-based analysis (callers fall back to deterministic, so it could look "fine" in the UI).
- **Fix:** restored the helper (tolerant fence-stripping JSON parse). **RESOLVED.**

### HIGH — Lead-synthesis LLM output discarded
- File: `backend/src/aiAgent.js` (verdict object, ~line 447)
- **Issue:** `callLLM(role:'lead')` result was parsed into `summaryText`, but `verdict.summary` still formatted the deterministic template. With `enableLeadSynthesis: true` a full extra LLM round-trip ran and its result was never surfaced.
- **Fix:** `summary: summaryText` (falls back to deterministic text when LLM is off/fails). **RESOLVED.**

## Passed (traced, no issues)

- **Hedged fallback race** (`llmClient.js:callLLM`) — hard failures reject fast (before the hedge fires); slow providers parallelize via the hedge; every attempt has `.catch` (no unhandled rejections); the primary can still win after a hedge is admitted.
- **SWR audit cache** (`aiAgent.js:getCachedAudit`) — stale report returns immediately with a deduped background refresh; the guardian passes `allowBlocking:false` so the tick never awaits an LLM.
- **`mapLimit` scan** — candidates capped at `limit`, DexScreener snapshot batched, per-token failures swallowed per item.
- **Config knobs** — the 3 new fields are present in `DEFAULT_AUTOPILOT`, the `setAutopilot` clamps, and the `registerStateProvider` slice (the usual persistence failure point).

## Tuning notes (intentional — verify against usage)

1. `passesPreFilter` liquidity floor is **$10k**, while `runRiskAssessment` approves at **$5k** — tokens in the $5–10k band are now never scanned.
2. Concurrency 3 ⇒ up to **9 concurrent LLM calls** per scan (3 × Bull/Bear + Lead) — watch provider rate limits if raised.

## Validation
- `node --check` on all modified backend files: pass.
- Frontend `npm run build` (`tsc -b && vite build`): pass, 371 modules.