// Single source of truth for the MetaMask connection AND the pending-intent
// engine. Mounted once at the shell (App), so connection state, bind status,
// and the approve loop survive page navigation.
// API: useEvmWallet() → mode/connection/bind/intents + connect/bind/approve/cancel.
//
// The server never signs. `approveIntent` is the ONLY path that moves real
// funds: it claims the intent, asks the backend for an unsigned 1inch tx,
// optionally approves the router, then hands the tx to MetaMask.
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { api, RealIntent } from '../api/client';
import {
  chainIdHexFromKey, chainKeyFromId, chainNameFromId, currentChainIdHex, getAccounts, getChainIdHex, getInjectedProvider,
  isInsecureOrigin, personalSign, requestAccounts, sendTransaction, subscribeProviders, toHexChainId, waitForReceipt, switchChain,
} from '../lib/evm';
import { nextAutoApprove } from '../lib/intents';

/** 1inch router — must match ONE_INCH_ROUTER in backend/src/evmWallet.js. */
const ALLOWED_ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65';
const ERC20_APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256)

/** Display name for a chain id, falling back to the raw value. */
function chainLabel(chain: string | number | null): string {
  return chainNameFromId(chain) ?? String(chain ?? 'tidak dikenal');
}

/**
 * The wallet is on a different chain than the trade was built for.
 *
 * Carries both chain ids so the caller can offer a one-click switch rather
 * than showing a raw hex number. It is deliberately NOT a user rejection: the
 * intent is still fine, it just needs the wallet pointed somewhere else first,
 * so it must not be added to `skippedRef` and forgotten.
 */
class ChainMismatchError extends Error {
  /** The wanted chain as a hex id (what `switchChain` takes). */
  readonly wantedHex: string;
  readonly wanted: number;
  readonly current: string;
  constructor(wantedHex: string, current: string) {
    const wanted = Number.parseInt(wantedHex, 16);
    const where = current === '' ? 'chain yang tidak terbaca' : chainLabel(current);
    super(`MetaMask di ${where}, transaksi butuh ${chainLabel(wantedHex)} (chain ${wanted})`);
    this.name = 'ChainMismatchError';
    this.wantedHex = wantedHex;
    this.wanted = wanted;
    this.current = current;
  }
}

interface EvmWalletState {
  loaded: boolean;
  available: boolean;
  connected: boolean;
  address: string | null;
  chainId: string | null;
  realMode: boolean;
  autoApprove: boolean;
  boundWallet: string | null;
  isBound: boolean;
  binding: boolean;
  bindError: string;
  intents: RealIntent[];
  openIntents: RealIntent[];
  approvingId: string | null;
  approveError: string;
  /** Non-null when a swap was refused because MetaMask is on another chain. */
  chainMismatch: { intentId: string; wanted: string; current: string } | null;
  connect: () => Promise<void>;
  setRealMode: (on: boolean) => Promise<void>;
  setAutoApprove: (on: boolean) => Promise<void>;
  bindWallet: () => Promise<boolean>;
  approveIntent: (intent: RealIntent) => Promise<void>;
  cancelIntent: (intent: RealIntent) => Promise<void>;
  refreshIntents: () => Promise<void>;
  switchToChain: (chainIdHex: string) => Promise<void>;
}

const EvmWalletContext = createContext<EvmWalletState | null>(null);

/** A 20-byte EVM address. Used to reject a malformed spender before encoding. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** 2^256 - 1 — the largest value that fits in one ABI word. */
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Pad a hex quantity to a 32-byte ABI word.
 *
 * Refuses a value that does not fit: `padStart` never truncates, so an over-long
 * amount would silently produce >32 bytes of calldata and shift every following
 * argument — a misaligned `approve(spender, amount)` pair.
 */
function pad32(hex: string): string {
  const body = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length > 64) {
    throw new Error('Nilai ABI tidak valid untuk di-encode');
  }
  return body.padStart(64, '0');
}

/**
 * Build approve(spender, amount) calldata without pulling in ethers.
 *
 * Validates both fields rather than trusting them: a malformed spender would be
 * left-padded into a DIFFERENT valid address (a 63-char string becomes a
 * different, attacker-chosen spender), and `BigInt` on a non-numeric amount
 * would throw into the generic transient path and retry silently. Fail here so
 * the caller classifies it as a permanent security refusal.
 */
function encodeApprove(spender: string, amount: string): string {
  if (!ADDRESS_RE.test(spender)) {
    throw new Error('Spender approve bukan alamat yang valid');
  }
  const value = BigInt(amount);
  if (value <= 0n || value > MAX_UINT256) {
    throw new Error('Jumlah approve di luar rentang uint256');
  }
  return `${ERC20_APPROVE_SELECTOR}${pad32(spender)}${pad32(value.toString(16))}`;
}

export function EvmWalletProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [realMode, setRealModeState] = useState(false);
  const [autoApprove, setAutoApproveState] = useState(false);
  const [boundWallet, setBoundWallet] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState('');
  const [intents, setIntents] = useState<RealIntent[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState('');
  // Set when a swap was refused because MetaMask is on another chain. The UI
  // offers a one-click switch instead of leaving the user to find the network
  // picker themselves.
  const [chainMismatch, setChainMismatch] = useState<
    { intentId: string; wanted: string; current: string } | null
  >(null);

  const [available, setAvailable] = useState(false);
  const runningRef = useRef(false);                              // one swap in flight
  const skippedRef = useRef<Set<string>>(new Set());             // user-rejected / permanent-fail ids
  const attemptsRef = useRef<Map<string, number>>(new Map());    // per-intent retry counter (session)
  const cooldownRef = useRef<Map<string, number>>(new Map());    // intentId -> next-allowed ts
  // Latest `approveIntent`, kept in a ref so the auto-approve effect can call it
  // without listing it as a dependency (which would re-fire the effect on every
  // render) and without capturing a stale closure.
  const approveRef = useRef<(intent: RealIntent) => Promise<void>>(async () => {});
  // Guards async chains that outlive this provider: approveIntent's awaited
  // steps (claim → swap-tx → sign → send) can resolve after unmount (logout,
  // navigation); writing state then is a torn-state bug.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const isBound = Boolean(address && boundWallet && boundWallet.toLowerCase() === address.toLowerCase());

  // Reconnect silently on load and follow MetaMask's own account/chain events,
  // so switching accounts in the extension does not leave a stale address here.
  useEffect(() => {
    let cancelled = false;
    const provider = getInjectedProvider();
    setAvailable(provider !== null);
    const sync = async () => {
      try {
        const [accounts, chain] = await Promise.all([getAccounts(), getChainIdHex()]);
        if (cancelled) return;
        const acct = accounts[0] ?? null;
        setAddress(acct);
        setConnected(Boolean(acct));
        setChainId(chain || null);
      } catch {}
      if (!cancelled) setLoaded(true);
    };
    // Without MetaMask there is nothing to talk to, and calling into whatever
    // else claimed window.ethereum is what produced MetaMask's opaque
    // "Unexpected error". Stay unloaded; the UI shows the install prompt.
    if (provider) {
      sync();
      const onChange = () => { sync(); };
      provider.on?.('accountsChanged', onChange);
      provider.on?.('chainChanged', onChange);
      return () => {
        cancelled = true;
        provider.removeListener?.('accountsChanged', onChange);
        provider.removeListener?.('chainChanged', onChange);
      };
    }
    // MetaMask can be installed or enabled after this page mounted. Pick it up
    // when it announces rather than requiring a reload.
    const unsubscribe = subscribeProviders(() => {
      if (cancelled || getInjectedProvider()) {
        setAvailable(true);
        unsubscribe();
        setLoaded(true);
      }
    });
    setLoaded(true);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // Load server-side mode + bind state whenever the active account changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, b, a] = await Promise.all([
          api.realMode(),
          api.boundWallet().catch(() => ({ boundWallet: null })),
          // The executor's approve permission is server-held authority. It is
          // read on its own so a failure here leaves the mode/bind state usable
          // rather than discarding all three — and a read failure must leave it
          // OFF, which the `false` default already does.
          api.autoApprove().catch(() => ({ autoApprove: false })),
        ]);
        if (cancelled) return;
        setRealModeState(m.realMode);
        setBoundWallet(b.boundWallet);
        setAutoApproveState(Boolean(a.autoApprove));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [address]);

  const refreshIntents = useCallback(async () => {
    try {
      const [list, b] = await Promise.all([
        api.realIntents(),
        api.boundWallet().catch(() => ({ boundWallet: null })),
      ]);
      setIntents(list);
      setBoundWallet(b.boundWallet);
    } catch {}
  }, []);

  // Poll intents — always mounted, so a pending intent is noticed on any page.
  // Paused while the tab is hidden: nobody is watching, and the backend's
  // per-user rate limit is shared with the rest of the dashboard.
  //
  // The interval tightens while auto-approve is armed: that is the one mode
  // where a new intent is supposed to reach MetaMask on its own, and the user
  // is waiting for the popup. Manual mode can afford the lazier 15s cadence.
  const pollMs = autoApprove ? 5_000 : 15_000;
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      refreshIntents();
      id = setInterval(refreshIntents, pollMs);
    };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshIntents, pollMs]);

  const connect = useCallback(async () => {
    const accounts = await requestAccounts();
    const acct = accounts[0] ?? null;
    setAddress(acct);
    setConnected(Boolean(acct));
    setChainId((await getChainIdHex()) || null);
  }, []);

  /**
   * Point the wallet at the chain a pending swap was built for.
   *
   * Re-reads `eth_chainId` afterwards rather than assuming the switch landed:
   * the user can decline the MetaMask prompt, and treating a declined switch as
   * success would send the tx to the wrong chain — the exact failure the chain
   * check exists to prevent.
   */
  const switchToChain = useCallback(async (chainIdHex: string) => {
    const hex = chainIdHex;
    await switchChain(hex);
    const now = await currentChainIdHex();
    if (now !== hex) {
      throw new Error(`Ganti chain gagal — MetaMask masih di ${chainLabel(now)}`);
    }
    if (mountedRef.current) {
      setChainId(now);
      setChainMismatch(null);
      setApproveError('');
    }
  }, []);

  // Clear a pending chain mismatch once the wallet actually lands on the wanted
  // chain. The in-app switch button clears it directly, but the user can also
  // switch networks inside MetaMask — that path only updates `chainId` via the
  // chainChanged handler, so without this the mismatch (and the auto-approve
  // bail that keys off it) would persist even though the problem is gone.
  useEffect(() => {
    if (chainMismatch && chainId === chainMismatch.wanted) {
      setChainMismatch(null);
      // The banner's text names the wrong chain; leaving it after the user
      // fixed the chain would be a stale, wrong statement.
      setApproveError('');
    }
  }, [chainId, chainMismatch]);

  const setRealMode = useCallback(async (on: boolean) => {
    setRealModeState(on);
    try {
      const r = await api.setRealMode(on);
      setRealModeState(Boolean(r.realMode));
    } catch {
      setRealModeState(!on);
    }
  }, []);

  // Optimistic with rollback, like setRealMode — but this one arms spending
  // authority, so the rollback path matters more: a failed POST must never
  // leave the UI claiming the bot can approve when the server refused.
  const setAutoApprove = useCallback(async (on: boolean) => {
    setAutoApproveState(on);
    try {
      const r = await api.setAutoApprove(on);
      setAutoApproveState(Boolean(r.autoApprove));
    } catch {
      setAutoApproveState(!on);
    }
  }, []);

  const bindWallet = useCallback(async () => {
    if (!address) { setBindError('Connect MetaMask dulu'); return false; }
    setBinding(true);
    setBindError('');
    try {
      const { message } = await api.bindMessage(address);
      const signature = await personalSign(message, address);
      const r = await api.bindWallet({ address, signature });
      // Trust the SERVER's recovered address, not the one we sent.
      setBoundWallet(r.address);
      return true;
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? 'Gagal bind wallet');
      setBindError(msg.slice(0, 200));
      return false;
    } finally {
      setBinding(false);
    }
  }, [address]);

  /**
   * Execute one intent: chain guard → claim → server builds the 1inch tx →
   * (approve router if the input is an ERC-20) → MetaMask signs → wait for the
   * receipt → mark done.
   *
   * The claim comes BEFORE the build because the server only builds a swap for
   * an `active` intent (server.js → 409 otherwise). Building first made every
   * fresh intent 409, which the classifier below then treated as permanent and
   * silently dropped from the pending list.
   *
   * Every failure mode is classified, because the consequences differ:
   *  - user rejected            → skip this intent, never auto-retry
   *  - tx already broadcast     → mark done anyway (re-opening would double-spend)
   *  - router not allow-listed  → permanent security refusal, skip
   *  - 4xx from the server      → permanent, skip
   *  - 5xx / 429                → transient, back off and retry a bounded number
   */
  const approveIntent = useCallback(async (intent: RealIntent) => {
    if (!address || runningRef.current) return;
    // Refuse to drive the wallet from an insecure origin. Over http (or a
    // tunnel) a network attacker can rewrite this app's own JavaScript, so a
    // signed tx here is not necessarily the tx this code built. The trade forms
    // only WARN about this; on the path that moves real funds it must block.
    // localhost/127.0.0.1 are exempt (see isInsecureOrigin), so dev is unaffected.
    if (isInsecureOrigin()) {
      setApproveError('Halaman tidak aman (bukan https/localhost) — eksekusi dana asli diblokir. Buka lewat https atau localhost.');
      return;
    }
    runningRef.current = true;
    setApprovingId(intent.id);
    setApproveError('');
    const claimToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    let claimed = false;
    let sentHash: string | null = null;
    // Set immediately BEFORE the swap is handed to MetaMask. If the send throws
    // with anything other than a user rejection, we cannot tell whether the node
    // broadcast it before the response was lost — and re-opening the intent would
    // then re-sign and re-send the SAME trade (a double-spend of real funds).
    // Distinct from `sentHash`, which is only set once a hash comes back.
    let swapSubmitted = false;
    let routerRefused = false;
    try {
      // Chain check BEFORE the claim and before any signature. It is a local
      // MetaMask read (no server call), and `intent.chainId` is a backend chain
      // key known without building — so a mismatch is caught without consuming
      // a claim.
      //
      // 1inch's router is CREATE2-deployed at the same address on every chain,
      // so the router allow-list below passes even on the wrong network, and
      // eth_sendTransaction would then execute there: gas burned on a revert
      // for a buy, or an allowance granted for a same-address token with
      // different meaning for a sell. Never silently execute on the wrong chain.
      //
      // Fail CLOSED when either side cannot be read: an unknown intent chain or
      // an unreadable eth_chainId must refuse the trade, not skip the check. An
      // unreadable chain is also the state where the wallet may be anywhere.
      const wantChain = chainIdHexFromKey(intent.chainId);
      if (!wantChain) {
        throw new Error(`Chain intent "${intent.chainId}" tidak dikenal — eksekusi dibatalkan`);
      }
      let haveChain: string;
      try {
        haveChain = await currentChainIdHex();
      } catch {
        haveChain = '';
      }
      if (!haveChain || haveChain !== wantChain) {
        throw new ChainMismatchError(wantChain, haveChain);
      }

      // Claim the intent active — the single-flight guard. Only now may the
      // server build the swap.
      await api.realIntentStatus(intent.id, 'active', claimToken);
      claimed = true;

      const built = await api.realSwapTx({ intentId: intent.id, from: address, chain: intent.chainId });

      // The router is the only contract we will ever grant an allowance to.
      // A response pointing elsewhere is refused BEFORE MetaMask is asked to
      // sign anything — this is the client half of the server's allow-list.
      // Post-claim now, so it is flagged permanent and released, not retried.
      if (String(built.to).toLowerCase() !== ALLOWED_ROUTER) {
        routerRefused = true;
        throw new Error('Router swap tidak dikenal — eksekusi dibatalkan demi keamanan');
      }

      // Defense in depth: the build could name a different chain than the intent
      // (server bug or a swapped response). Refuse rather than sign it.
      const builtChain = toHexChainId(built.chainId);
      if (builtChain !== wantChain) {
        throw new ChainMismatchError(wantChain, haveChain);
      }

      // Re-read the active account after the await chain above: the user can
      // switch accounts in MetaMask while the request is in flight, and sending
      // `from` with a stale address either makes MetaMask refuse the tx or, on
      // a provider that does not enforce `from`, signs from the wrong account.
      const liveAccounts = await getAccounts();
      const liveAddress = liveAccounts[0] ?? null;
      if (!liveAddress || liveAddress.toLowerCase() !== address.toLowerCase()) {
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
        throw new Error('Akun MetaMask berubah di tengah transaksi — intent dibuka kembali, ulangi dengan akun yang benar');
      }

      // ERC-20 input needs an allowance. Approve the EXACT amount, never an
      // unlimited grant: a compromised router must not be able to drain the
      // token balance long after this trade.
      //
      // The allowance target is the FUNDING token, which is not always
      // `intent.tokenAddress`: a USDT-funded buy approves the USDT contract,
      // not the token being bought. The server names it in `approveToken`;
      // the fallback keeps older responses (sells) working.
      //
      // The approve leg is allow-listed here too — the swap's `to` check above
      // does NOT cover it. Without this, a spoofed response could name an
      // attacker spender while `to` still passed, and MetaMask would show a
      // plausible "Approve USDT" prompt for a grant the attacker can drain.
      if (built.needsApproval && built.approveSpender && built.approveAmount) {
        const approveToken = built.approveToken ?? intent.tokenAddress;
        if (String(built.approveSpender).toLowerCase() !== ALLOWED_ROUTER) {
          routerRefused = true;
          throw new Error('Spender approve bukan router resmi — eksekusi dibatalkan demi keamanan');
        }
        if (!ADDRESS_RE.test(String(approveToken))) {
          routerRefused = true;
          throw new Error('Token approve bukan alamat yang valid — eksekusi dibatalkan');
        }
        let approveValue: bigint;
        try {
          approveValue = BigInt(built.approveAmount);
        } catch {
          routerRefused = true;
          throw new Error('Jumlah approve bukan angka — eksekusi dibatalkan');
        }
        if (approveValue <= 0n || approveValue === MAX_UINT256) {
          routerRefused = true;
          throw new Error('Approve tanpa batas atau nol ditolak — hanya jumlah persis yang diizinkan');
        }
        const approveHash = await sendTransaction({
          from: address,
          to: approveToken,
          data: encodeApprove(built.approveSpender, built.approveAmount),
        });
        const receipt = await waitForReceipt(approveHash);
        if (receipt.status === 'reverted') throw new Error('Approve token gagal di on-chain');
      }

      // Validate the swap calldata before signing. `to` is allow-listed above,
      // but a response with a non-hex `data` or an unparseable `value` would
      // otherwise reach MetaMask as-is — and `value` is a decimal wei string the
      // user cannot eyeball. Fail as a permanent refusal, not a retry.
      if (!/^0x([0-9a-fA-F]{2})*$/.test(String(built.data))) {
        routerRefused = true;
        throw new Error('Calldata swap tidak valid — eksekusi dibatalkan demi keamanan');
      }
      let swapValue: bigint;
      try {
        swapValue = BigInt(built.value ?? '0');
      } catch {
        routerRefused = true;
        throw new Error('Nilai swap bukan angka — eksekusi dibatalkan');
      }
      if (swapValue < 0n) {
        routerRefused = true;
        throw new Error('Nilai swap negatif — eksekusi dibatalkan');
      }

      swapSubmitted = true;
      const txHash = await sendTransaction({
        from: address,
        to: built.to,
        data: built.data,
        value: swapValue === 0n ? undefined : built.value,
        gas: built.gas ?? undefined,
      });
      sentHash = txHash;

      const receipt = await waitForReceipt(txHash);
      if (receipt.status === 'reverted') {
        // The chain rejected it — no funds moved, so the intent can safely be
        // reopened for another attempt.
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
        throw new Error(`Transaksi di-revert on-chain (${txHash.slice(0, 10)}…) — tidak ada dana yang berpindah`);
      }

      await api.realIntentStatus(intent.id, 'done', claimToken);
      attemptsRef.current.delete(intent.id);
      cooldownRef.current.delete(intent.id);
      skippedRef.current.delete(intent.id);
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (e instanceof ChainMismatchError) {
        // Not a rejection and not permanent — the user just needs to switch
        // networks. The pre-claim guard leaves the intent untouched, but a
        // mismatch found AFTER the claim (the built tx names another chain)
        // leaves it `active`; release it so it does not strand until the TTL
        // sweep. `if (claimed)` keeps the common pre-claim case free of a
        // needless reopen.
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
        if (mountedRef.current) {
          setChainMismatch({ intentId: intent.id, wanted: e.wantedHex, current: e.current });
          setApproveError(e.message);
        }
      } else if (routerRefused) {
        // The server handed back a contract we never grant allowances to. This
        // is a security refusal, not a transient fault — never retry it, and
        // release the claim so the intent is not stuck active.
        skippedRef.current.add(intent.id);
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
        if (mountedRef.current) {
          setApproveError(`${msg.slice(0, 200)} — intent dilewati (penolakan keamanan, tidak diulang).`);
          refreshIntents();
        }
      } else if (/user rejected|user denied|rejected the request/i.test(msg)) {
        // The user said no. Reopen so they can retry later, but do not nag.
        skippedRef.current.add(intent.id);
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
      } else if (sentHash) {
        // CRITICAL: the tx is already broadcast. Re-opening the intent would let
        // the next approve send the SAME trade again → double-spend of real
        // funds. Mark it done instead; the user verifies on the explorer.
        //
        // Also skip it locally: if the `done` call above fails, the server may
        // sweep the still-active intent back to `open` after the TTL, and the
        // auto-approve loop would otherwise rebuild and re-send this exact
        // trade. Never auto-retry a hash we already broadcast.
        skippedRef.current.add(intent.id);
        try { await api.realIntentStatus(intent.id, 'done', claimToken); } catch {}
        if (mountedRef.current) {
          setApproveError(`Tx terkirim tapi belum terkonfirmasi (${sentHash.slice(0, 10)}…). Cek explorer — intent ditandai selesai untuk mencegah eksekusi dobel.`);
          refreshIntents();
        }
        return;
      } else if (swapSubmitted) {
        // The swap was handed to MetaMask but the send threw without a hash and
        // the user did not reject it — e.g. the node broadcast it and the RPC
        // response was lost. We cannot prove no funds moved, so treat it like a
        // broadcast: mark done and skip locally rather than re-open and re-send
        // the same trade (a double-spend). The user verifies on the explorer.
        skippedRef.current.add(intent.id);
        try { await api.realIntentStatus(intent.id, 'done', claimToken); } catch {}
        if (mountedRef.current) {
          setApproveError(`${msg.slice(0, 160)} — tx mungkin sudah terkirim tanpa hash balik. Cek explorer sebelum mencoba lagi; intent ditandai selesai untuk mencegah eksekusi dobel.`);
          refreshIntents();
        }
        return;
      } else {
        // A 4xx is PERMANENT: the server rejected the request itself (wrong
        // chain, bad intent, no route). Retrying can never succeed, so skip it
        // rather than hammering the API into a 429 that buries the real error.
        //
        // 429 is the exception: it means "too many requests", which the retry
        // path below exists to survive. `quote`, `swap-tx` and `manual-intent`
        // share ONE rate-limit bucket, so browsing quotes can rate-limit the
        // swap build — treating that as permanent would silently drop the trade
        // with no UI path to un-skip it.
        const status = (e as { status?: number })?.status;
        const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
        if (permanent) {
          skippedRef.current.add(intent.id);
          if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
          if (mountedRef.current) {
            setApproveError(`${msg.slice(0, 200)} — intent dilewati (error permanen, tidak diulang).`);
            refreshIntents();
          }
          return;
        }
        // Transient (5xx/429): back off and allow a bounded number of retries.
        const n = (attemptsRef.current.get(intent.id) ?? 0) + 1;
        attemptsRef.current.set(intent.id, n);
        if (n >= 3) skippedRef.current.add(intent.id);
        // Without a cooldown the reopened intent re-fires immediately (the
        // pending list is a fresh array) → a sub-second claim/reopen burst.
        cooldownRef.current.set(intent.id, Date.now() + Math.min(30_000, 2_000 * 2 ** (n - 1)));
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
      }
      if (mountedRef.current) setApproveError(msg.slice(0, 200));
    } finally {
      runningRef.current = false;
      if (mountedRef.current) {
        setApprovingId(null);
        refreshIntents();
      }
    }
  }, [address, refreshIntents]);

  const cancelIntent = useCallback(async (intent: RealIntent) => {
    try {
      await api.realIntentStatus(intent.id, 'cancelled');
      skippedRef.current.delete(intent.id);
      attemptsRef.current.delete(intent.id);
      cooldownRef.current.delete(intent.id);
      if (mountedRef.current) await refreshIntents();
    } catch {}
  }, [refreshIntents]);

  const openIntents = useMemo(
    () => intents.filter((i) => i.status === 'open' && !skippedRef.current.has(i.id)),
    [intents],
  );

  // Keep the ref pointed at the newest closure. Written in an effect (never
  // during render) so the auto-approve effect below always calls current state.
  useEffect(() => { approveRef.current = approveIntent; }, [approveIntent]);

  // Auto-approve: when armed, hand the next eligible intent to MetaMask on its
  // own. It cannot sign — the server holds no keys — so "automatic" means
  // opening the wallet prompt for the user, not approving on their behalf.
  //
  // Loop safety: `approveIntent` flips `runningRef` synchronously before its
  // first await, so the re-render this effect causes bails at that guard. And
  // every run ends in {done, skipped, cooldown}, so `nextAutoApprove` cannot
  // select the same intent twice — the effect fires on state changes, never in
  // a render loop.
  //
  // The selector itself filters to intents on the wallet's CURRENT chain, so a
  // wrong-chain intent is never handed over and one mismatch cannot freeze the
  // loop for every other intent. An unreadable/unsupported chain selects nothing
  // (fail closed) — the same refusal `approveIntent` enforces.
  useEffect(() => {
    if (!autoApprove || !realMode || !connected || !isBound || !address) return;
    const next = nextAutoApprove(intents, {
      skipped: skippedRef.current,
      cooldownUntil: cooldownRef.current,
      now: Date.now(),
      currentChainKey: chainKeyFromId(chainId),
    });
    if (next) approveRef.current(next);
  }, [autoApprove, realMode, connected, isBound, address, chainId, intents]);

  const value = useMemo<EvmWalletState>(() => ({
    loaded, available, connected, address, chainId,
    realMode, autoApprove, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError, chainMismatch,
    connect, setRealMode, setAutoApprove, bindWallet, approveIntent, cancelIntent, refreshIntents, switchToChain,
  }), [
    loaded, available, connected, address, chainId,
    realMode, autoApprove, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError, chainMismatch,
    connect, setRealMode, setAutoApprove, bindWallet, approveIntent, cancelIntent, refreshIntents, switchToChain,
  ]);

  return <EvmWalletContext.Provider value={value}>{children}</EvmWalletContext.Provider>;
}

export function useEvmWallet(): EvmWalletState {
  const ctx = useContext(EvmWalletContext);
  if (!ctx) throw new Error('useEvmWallet must be used within EvmWalletProvider');
  return ctx;
}

export { switchChain };
