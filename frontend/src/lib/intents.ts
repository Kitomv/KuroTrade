// Intent-loop math for the MetaMask approve path, kept pure and outside the
// provider so the selection rule can be tested without a DOM.
// Importers/callers: components/EvmWalletContext.tsx; scripts/intentApprove.check.mts.
//
// The provider holds a pending-intent queue and, when auto-approve is armed,
// picks the next one to hand to MetaMask. That choice is the only thing standing
// between "opens MetaMask once per intent" and "opens it forever in a loop", so
// it lives here as a single testable rule.

/** The minimal shape the selector needs from a pending intent. */
export interface ApprovableIntent {
  id: string;
  status: string;
  /** Backend chain key the intent must execute on (e.g. 'base'). */
  chainId: string;
}

/**
 * The next intent the auto-approve loop should execute, or null.
 *
 * An intent is eligible when it is `open`, targets the wallet's CURRENT chain,
 * has not been skipped, and is not still inside a cooldown. Returning at most
 * ONE per call is what keeps the loop from firing a burst: the caller runs it,
 * that run resolves the intent (done/cancelled), skips it, or sets a cooldown —
 * so the next call cannot select the same intent again until real state changes.
 *
 * The chain filter is what stops one wrong-chain intent from freezing the whole
 * loop: auto-approve only ever drives an intent that matches the wallet's chain,
 * so a mismatch never reaches `approveIntent` on this path at all. A mismatch
 * the user hits by pressing Approve manually still raises the switch banner.
 * `currentChainKey === null` (chain unreadable or unsupported) executes nothing —
 * fail closed, because an unreadable chain is exactly when the wallet may be
 * anywhere.
 */
export function nextAutoApprove<T extends ApprovableIntent>(
  intents: readonly T[],
  {
    skipped,
    cooldownUntil,
    now,
    currentChainKey,
  }: {
    skipped: ReadonlySet<string>;
    cooldownUntil: ReadonlyMap<string, number>;
    now: number;
    /** Backend chain key of the wallet's current chain; null when unreadable. */
    currentChainKey: string | null;
  },
): T | null {
  if (!currentChainKey) return null;
  for (const intent of intents) {
    if (intent.status !== 'open') continue;
    if (intent.chainId !== currentChainKey) continue;
    if (skipped.has(intent.id)) continue;
    const until = cooldownUntil.get(intent.id);
    if (until !== undefined && until > now) continue;
    return intent;
  }
  return null;
}
