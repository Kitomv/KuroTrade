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
  chainNameFromId, currentChainIdHex, getAccounts, getChainIdHex, getInjectedProvider, personalSign,
  requestAccounts, sendTransaction, subscribeProviders, toHexChainId, waitForReceipt, switchChain,
} from '../lib/evm';

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
  readonly wanted: number;
  readonly current: string;
  constructor(wanted: number, current: string) {
    const where = current === '' ? 'chain yang tidak terbaca' : chainLabel(current);
    super(`MetaMask di ${where}, transaksi butuh ${chainLabel(wanted)} (chain ${wanted})`);
    this.name = 'ChainMismatchError';
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
  boundWallet: string | null;
  isBound: boolean;
  binding: boolean;
  bindError: string;
  intents: RealIntent[];
  openIntents: RealIntent[];
  approvingId: string | null;
  approveError: string;
  /** Non-null when a swap was refused because MetaMask is on another chain. */
  chainMismatch: { intentId: string; wanted: number; current: string } | null;
  connect: () => Promise<void>;
  setRealMode: (on: boolean) => Promise<void>;
  bindWallet: () => Promise<boolean>;
  approveIntent: (intent: RealIntent) => Promise<void>;
  cancelIntent: (intent: RealIntent) => Promise<void>;
  refreshIntents: () => Promise<void>;
  switchToChain: (chainId: number) => Promise<void>;
}

const EvmWalletContext = createContext<EvmWalletState | null>(null);

/** Pad a hex quantity to a 32-byte ABI word. */
function pad32(hex: string): string {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

/** Build approve(spender, amount) calldata without pulling in ethers. */
function encodeApprove(spender: string, amount: string): string {
  return `${ERC20_APPROVE_SELECTOR}${pad32(spender)}${pad32(BigInt(amount).toString(16))}`;
}

export function EvmWalletProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [realMode, setRealModeState] = useState(false);
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
    { intentId: string; wanted: number; current: string } | null
  >(null);

  const [available, setAvailable] = useState(false);
  const runningRef = useRef(false);                              // one swap in flight
  const skippedRef = useRef<Set<string>>(new Set());             // user-rejected / permanent-fail ids
  const attemptsRef = useRef<Map<string, number>>(new Map());    // per-intent retry counter (session)
  const cooldownRef = useRef<Map<string, number>>(new Map());    // intentId -> next-allowed ts
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
        const [m, b] = await Promise.all([
          api.realMode(),
          api.boundWallet().catch(() => ({ boundWallet: null })),
        ]);
        if (cancelled) return;
        setRealModeState(m.realMode);
        setBoundWallet(b.boundWallet);
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
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      refreshIntents();
      id = setInterval(refreshIntents, 15_000);
    };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshIntents]);

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
  const switchToChain = useCallback(async (chainId: number) => {
    const hex = toHexChainId(chainId);
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

  const setRealMode = useCallback(async (on: boolean) => {
    setRealModeState(on);
    try {
      const r = await api.setRealMode(on);
      setRealModeState(Boolean(r.realMode));
    } catch {
      setRealModeState(!on);
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
   * Execute one intent: claim → server builds the 1inch tx → (approve router if
   * the input is an ERC-20) → MetaMask signs → wait for the receipt → mark done.
   *
   * Every failure mode is classified, because the consequences differ:
   *  - user rejected            → skip this intent, never auto-retry
   *  - tx already broadcast     → mark done anyway (re-opening would double-spend)
   *  - 4xx from the server      → permanent, skip
   *  - 5xx / 429                → transient, back off and retry a bounded number
   */
  const approveIntent = useCallback(async (intent: RealIntent) => {
    if (!address || runningRef.current) return;
    runningRef.current = true;
    setApprovingId(intent.id);
    setApproveError('');
    const claimToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    let claimed = false;
    let sentHash: string | null = null;
    try {
      const built = await api.realSwapTx({ intentId: intent.id, from: address, chain: intent.chainId });

      // The router is the only contract we will ever grant an allowance to.
      // A response pointing elsewhere is refused BEFORE MetaMask is asked to
      // sign anything — this is the client half of the server's allow-list.
      if (String(built.to).toLowerCase() !== ALLOWED_ROUTER) {
        throw new Error('Router swap tidak dikenal — eksekusi dibatalkan demi keamanan');
      }

      // Chain check BEFORE any signature. 1inch's router is CREATE2-deployed at
      // the same address on every chain, so the router check above passes even
      // when the wallet sits on the wrong network — eth_sendTransaction would
      // then execute on that chain, reverting (gas burned) for a buy or landing
      // an allowance for a same-address token with different meaning for a sell.
      // Offer the switch; never silently execute on the wrong chain.
      //
      // Fail CLOSED when the chain cannot be read: an unreadable eth_chainId
      // must refuse the trade, not skip the check. The previous `haveChain &&`
      // form let an RPC hiccup bypass the guard entirely — the one case where
      // it matters most, because an unreadable chain is also the state where
      // the wallet may be anywhere.
      const wantChain = toHexChainId(built.chainId);
      let haveChain: string;
      try {
        haveChain = await currentChainIdHex();
      } catch {
        haveChain = '';
      }
      if (!haveChain || haveChain !== wantChain) {
        throw new ChainMismatchError(built.chainId, haveChain);
      }

      await api.realIntentStatus(intent.id, 'active', claimToken);
      claimed = true;

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
      if (built.needsApproval && built.approveSpender && built.approveAmount) {
        const approveHash = await sendTransaction({
          from: address,
          to: intent.tokenAddress,
          data: encodeApprove(built.approveSpender, built.approveAmount),
        });
        const receipt = await waitForReceipt(approveHash);
        if (receipt.status === 'reverted') throw new Error('Approve token gagal di on-chain');
      }

      const txHash = await sendTransaction({
        from: address,
        to: built.to,
        data: built.data,
        value: built.value,
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
        // Not a rejection and not permanent — the intent is untouched (the
        // claim happens after this check), so offer the switch and stop. The
        // user retries once the wallet is on the right network.
        if (mountedRef.current) {
          setChainMismatch({ intentId: intent.id, wanted: e.wanted, current: e.current });
          setApproveError(e.message);
        }
      } else if (/user rejected|user denied|rejected the request/i.test(msg)) {
        // The user said no. Reopen so they can retry later, but do not nag.
        skippedRef.current.add(intent.id);
        if (claimed) { try { await api.realIntentStatus(intent.id, 'open', claimToken); } catch {} }
      } else if (sentHash) {
        // CRITICAL: the tx is already broadcast. Re-opening the intent would let
        // the next approve send the SAME trade again → double-spend of real
        // funds. Mark it done instead; the user verifies on the explorer.
        try { await api.realIntentStatus(intent.id, 'done', claimToken); } catch {}
        if (mountedRef.current) {
          setApproveError(`Tx terkirim tapi belum terkonfirmasi (${sentHash.slice(0, 10)}…). Cek explorer — intent ditandai selesai untuk mencegah eksekusi dobel.`);
          refreshIntents();
        }
        return;
      } else {
        // A 4xx is PERMANENT: the server rejected the request itself (wrong
        // chain, bad intent, no route). Retrying can never succeed, so skip it
        // rather than hammering the API into a 429 that buries the real error.
        const status = (e as { status?: number })?.status;
        const permanent = typeof status === 'number' && status >= 400 && status < 500;
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

  const value = useMemo<EvmWalletState>(() => ({
    loaded, available, connected, address, chainId,
    realMode, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError, chainMismatch,
    connect, setRealMode, bindWallet, approveIntent, cancelIntent, refreshIntents, switchToChain,
  }), [
    loaded, available, connected, address, chainId,
    realMode, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError, chainMismatch,
    connect, setRealMode, bindWallet, approveIntent, cancelIntent, refreshIntents, switchToChain,
  ]);

  return <EvmWalletContext.Provider value={value}>{children}</EvmWalletContext.Provider>;
}

export function useEvmWallet(): EvmWalletState {
  const ctx = useContext(EvmWalletContext);
  if (!ctx) throw new Error('useEvmWallet must be used within EvmWalletProvider');
  return ctx;
}

export { switchChain };
