// Real-wallet intent state: persisted, per-user, guarded transitions.
// Importers/callers: server.js (/api/real/*), aiAgent.js (emit intents).
// Persisted fields: realMode:boolean, realAuto:boolean, boundWallet:string|null,
// realIntents:[{id,symbol,tokenAddress,chainId,side,source,amountUsd,amountSol,
//   estTokens,intentPrice,status,createdAt,claimedAt,claimToken,resolvedAt?}].
// User instruction: "audit real wallet" → fix ALL findings incl. overspend,
// persistence, races, swap binding, and wallet binding.
import { randomBytes, randomUUID } from 'crypto';
import { loadUserState, touch, registerStateProvider } from './persistence.js';
import { buildBindMessage, verifyEvmSignature } from './evmBind.js';
import { reducePositionAmount, addMirroredPosition, updatePositionMetadata } from './wallet.js';

const INTENT_TTL_MS = 30 * 60 * 1000;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const BIND_NONCE_TTL_MS = 5 * 60 * 1000;
// EVM chains this build can execute. Anything else can never be filled: the
// intent would sit 'open' forever and — via the buy-dedup guard — permanently
// block fresh signals for that token.
const SUPPORTED_CHAINS = new Set([
  'base', 'ethereum', 'arbitrum', 'bsc', 'optimism', 'polygon', 'avalanche',
]);
const realStates = new Map(); // userId -> { realMode, boundWallet, bindNonce, intents }

function stateFor(userId) {
  if (realStates.has(userId)) return realStates.get(userId);
  const saved = loadUserState(userId) ?? {};
  const state = {
    realMode: Boolean(saved.realMode),
    boundWallet: typeof saved.boundWallet === 'string' ? saved.boundWallet : null,
    bindNonce: typeof saved.bindNonce === 'object' && typeof saved.bindNonce?.value === 'string' ? saved.bindNonce : null,
    intents: Array.isArray(saved.realIntents) ? saved.realIntents : [],
  };
  realStates.set(userId, state);
  return state;
}

function liveIntents(state) {
  const now = Date.now();
  let changed = false;
  const out = [];
  for (const intent of state.intents) {
    if (now - Number(intent.createdAt) >= INTENT_TTL_MS) { changed = true; continue; }
    // Release abandoned claims; a crashed tab must not strand a trade forever.
    if (intent.status === 'active' && now - Number(intent.claimedAt || 0) >= CLAIM_TTL_MS) {
      intent.status = 'open';
      delete intent.claimedAt;
      delete intent.claimToken;
      changed = true;
    }
    // Auto-cancel intents for chains this app cannot execute. Execution is
    // EVM-only (1inch + MetaMask), so a non-EVM intent can never be filled:
    // it would sit 'open' forever and — via the buy-dedup guard — permanently
    // block fresh signals for that token. A missing chainId is left alone
    // (pre-field intents have no chain to judge, and cancelling a chain-less
    // intent would be guessing).
    if (
      (intent.status === 'open' || intent.status === 'active')
      && typeof intent.chainId === 'string' && intent.chainId !== ''
      && !SUPPORTED_CHAINS.has(intent.chainId.toLowerCase())
    ) {
      intent.status = 'cancelled';
      intent.resolvedAt = now;
      intent.cancelReason = 'unsupported_chain';
      delete intent.claimToken;
      delete intent.claimedAt;
      changed = true;
    }
    out.push(intent);
  }
  if (changed) { state.intents = out; }
  return { intents: out, changed };
}

// Persistence provider — must hydrate even if this user has not touched the
// real UI yet, otherwise a wallet flush could drop persisted real fields.
registerStateProvider((userId) => {
  const state = stateFor(userId);
  const { intents, changed } = liveIntents(state);
  if (changed) state.intents = intents;
  return {
    realMode: Boolean(state.realMode),
    boundWallet: state.boundWallet,
    bindNonce: state.bindNonce,
    realIntents: intents.slice(-100),
  };
});

export function isRealMode(userId) {
  return stateFor(userId).realMode;
}

export function setRealMode(userId, on) {
  const state = stateFor(userId);
  state.realMode = Boolean(on);
  touch(userId);
  return { realMode: state.realMode };
}

export function getBoundWallet(userId) {
  return stateFor(userId).boundWallet;
}

/**
 * Issue a fresh single-use bind challenge (anti-replay). The client signs the
 * returned message in MetaMask; bindWallet consumes the nonce exactly once.
 */
export function createBindChallenge(userId, address) {
  const state = stateFor(userId);
  const nonce = randomBytes(16).toString('hex');
  state.bindNonce = { value: nonce, exp: Date.now() + BIND_NONCE_TTL_MS };
  touch(userId);
  return { message: buildBindMessage(userId, address, nonce) };
}

export function bindWallet(userId, address, signature) {
  const state = stateFor(userId);
  const challenge = state.bindNonce;
  if (!challenge || typeof challenge.value !== 'string') {
    throw new Error('Challenge bind tidak ditemukan — minta pesan baru');
  }
  if (Date.now() > Number(challenge.exp)) {
    state.bindNonce = null;
    touch(userId);
    throw new Error('Challenge bind kadaluarsa — minta pesan baru');
  }
  const message = buildBindMessage(userId, address, challenge.value);
  if (!verifyEvmSignature(address, message, signature)) throw new Error('Signature wallet tidak valid');
  state.bindNonce = null; // single-use: a captured signature cannot be replayed
  state.boundWallet = address;
  touch(userId);
  return { bound: true, address };
}

export function assertBoundWallet(userId, publicKey) {
  const bound = stateFor(userId).boundWallet;
  if (!bound) throw new Error('Wallet belum di-bind; sign message terlebih dahulu');
  if (bound !== publicKey) throw new Error('Wallet tidak cocok dengan wallet yang di-bind');
  return true;
}

export function addRealIntent(userId, intent) {
  const state = stateFor(userId);
  const { intents } = liveIntents(state);
  const created = {
    ...intent,
    id: `int_${randomUUID()}`,
    status: 'open',
    createdAt: Date.now(),
  };
  state.intents = [...intents, created].slice(-100);
  touch(userId);
  return created;
}

export function getRealIntents(userId) {
  const state = stateFor(userId);
  const { intents, changed } = liveIntents(state);
  if (changed) touch(userId);
  return intents;
}

/** Single real intent by id — used by the server-backed swap rebuild (M3). */
export function getRealIntent(userId, intentId) {
  const state = stateFor(userId);
  const { intents } = liveIntents(state);
  return intents.find((i) => i.id === intentId) ?? null;
}

/** Guarded intent state machine; claimToken prevents two browser tabs sharing a claim. */
export function setRealIntentStatus(userId, intentId, status, claimToken = null) {
  const state = stateFor(userId);
  const { intents } = liveIntents(state);
  const intent = intents.find((i) => i.id === intentId);
  if (!intent) throw new Error('Intent tidak ditemukan');
  const from = intent.status;
  if (from === 'done' && status === 'done') return intent; // idempotent confirmation retry
  const allowed = (from === 'open' && (status === 'active' || status === 'cancelled'))
    || (from === 'active' && (status === 'done' || status === 'open'));
  if (!allowed) throw new Error(`transisi tidak valid: ${from} -> ${status}`);
  if (status === 'active') {
    // `from` is provably 'open' here: the gate above only admits open->active
    // for this branch (an earlier "already claimed" guard was unreachable).
    intent.claimToken = claimToken || randomUUID();
    intent.claimedAt = Date.now();
  } else if (from === 'active' && intent.claimToken && claimToken !== intent.claimToken) {
    throw new Error('intent claimed by another session');
  }
  intent.status = status;
  if (status === 'open') { delete intent.claimToken; delete intent.claimedAt; }
  if (status === 'done') {
    intent.resolvedAt = Date.now();
    // Keep the virtual book aligned with confirmed real-wallet fills. This
    // prevents repeated real exits and lets the guardian protect real buys.
    if (intent.side === 'sell') {
      // Cost basis must be captured BEFORE the reduce — afterwards the entry
      // is gone and the realized PnL is unrecoverable.
      const costUsd = (Number(intent.estTokens) || 0) * (Number(intent.entryAvgPrice) || Number(intent.intentPrice) || 0);
      const proceedsUsd = (Number(intent.estTokens) || 0) * (Number(intent.intentPrice) || 0);
      reducePositionAmount(userId, intent.tokenAddress, intent.estTokens);
      // A confirmed TP1 (50% partial) arms the moonbag TP2. Doing this here —
      // not at emit time — means a user-cancelled TP1 never triggers a full
      // moonbag sell of a position that was never partially exited.
      if (intent.source === 'TP1') {
        updatePositionMetadata(userId, intent.tokenAddress, { tp1Hit: true });
      }
      // Realized PnL is booked HERE, on confirmation — not when the intent was
      // emitted. An intent the user never approved is a proposal, not a trade,
      // and counting it would inflate the win rate and total profit with
      // phantom round trips. recordRealized dedups on the intent id, so a
      // retried confirmation cannot double-count.
      recordRealizedOnDone(userId, intent, proceedsUsd - costUsd);
    } else if (intent.side === 'buy') {
      // The swap's actual output is not persisted on the intent. `estTokens` is
      // the conservative model estimate, used only for guardian bookkeeping;
      // the UI displays on-chain balances as the source of truth.
      addMirroredPosition(userId, {
        tokenAddress: intent.tokenAddress,
        symbol: intent.symbol,
        chainId: intent.chainId,
        tokens: intent.estTokens,
        price: intent.intentPrice,
      });
    }
  } else if (status === 'cancelled') {
    intent.resolvedAt = Date.now();
  }
  state.intents = intents;
  touch(userId);
  return intent;
}

/**
 * Book a confirmed real exit into the autopilot stats + decision memory.
 *
 * Lives here rather than in the guardian tick because the guardian no longer
 * knows whether an intent was ever approved — only this confirmation path
 * does. Imported lazily: aiAgent.js imports realIntent.js, so a static import
 * would be a cycle.
 */
function recordRealizedOnDone(userId, intent, pnlUsd) {
  try {
    const mod = autopilotModule;
    if (!mod?.recordRealized) return;
    mod.recordRealized(userId, { pnlUsd, intentId: intent.id, key: intent.id });
    mod.logRealizedExit?.(userId, intent, pnlUsd);
  } catch {
    // A stats-bookkeeping failure must never fail the state transition — the
    // trade genuinely executed, and the position mirror above already applied.
  }
}

/** Set by aiAgent.js at import time; null when the agent module is absent. */
let autopilotModule = null;
export function registerAutopilotModule(mod) {
  autopilotModule = mod;
}

/**
 * Mark an intent done from ANY live state, claiming it first when needed.
 *
 * Server-side executors (the hot wallet) bypass the browser claim flow, but the
 * guarded state machine only allows `open -> active` and `active -> done`. A
 * direct `open -> done` throws — and that failure happens AFTER the swap is
 * already broadcast on-chain, leaving the intent `open` so the next tick could
 * execute the SAME trade again (double spend). This helper closes that window.
 */
export function resolveIntentAsDone(userId, intentId, { force = false } = {}) {
  const state = stateFor(userId);
  const { intents } = liveIntents(state);
  const intent = intents.find((i) => i.id === intentId);
  if (!intent) throw new Error('Intent tidak ditemukan');
  if (intent.status === 'done') return intent; // idempotent — never re-apply bookkeeping
  if (force) {
    // Last-resort close for a swap that is ALREADY BROADCAST on-chain. The
    // claim-token guard exists to stop two browser tabs racing to resolve one
    // intent; it must never be able to strand an executed trade. A stranded
    // intent stays 'open' and the autopilot's next tick (or a user's manual
    // retry) would execute the SAME trade a second time → double spend of real
    // funds. The caller passes force only when on-chain execution is confirmed,
    // so closing here is honest — the trade did happen.
    if (intent.status === 'open') {
      intent.claimToken = intent.claimToken || randomUUID();
      intent.claimedAt = intent.claimedAt || Date.now();
    }
    intent.status = 'done';
    intent.resolvedAt = Date.now();
    // Apply the same side-effects the claim-based path applies (persistence
    // mirrors the intent into the virtual ledger, so the two must agree).
    if (intent.side === 'sell') {
      const costUsd = (Number(intent.estTokens) || 0) * (Number(intent.entryAvgPrice) || Number(intent.intentPrice) || 0);
      const proceedsUsd = (Number(intent.estTokens) || 0) * (Number(intent.intentPrice) || 0);
      reducePositionAmount(userId, intent.tokenAddress, intent.estTokens);
      if (intent.source === 'TP1') {
        updatePositionMetadata(userId, intent.tokenAddress, { tp1Hit: true });
      }
      recordRealizedOnDone(userId, intent, proceedsUsd - costUsd);
    } else if (intent.side === 'buy') {
      addMirroredPosition(userId, {
        tokenAddress: intent.tokenAddress,
        symbol: intent.symbol,
        chainId: intent.chainId,
        tokens: intent.estTokens,
        price: intent.intentPrice,
      });
    }
    delete intent.claimToken;
    delete intent.claimedAt;
    state.intents = intents;
    touch(userId);
    return intent;
  }
  if (intent.status === 'open') {
    const claimed = setRealIntentStatus(userId, intentId, 'active');
    return setRealIntentStatus(userId, intentId, 'done', claimed.claimToken);
  }
  // 'active' → 'done' requires the matching claim token.
  return setRealIntentStatus(userId, intentId, 'done', intent.claimToken);
}

export { buildBindMessage };
