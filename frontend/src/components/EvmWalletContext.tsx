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
  getAccounts, getChainIdHex, hasInjectedWallet, personalSign, requestAccounts,
  sendTransaction, waitForReceipt, switchChain,
} from '../lib/evm';

/** 1inch router — must match ONE_INCH_ROUTER in backend/src/evmWallet.js. */
const ALLOWED_ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65';
const ERC20_APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256)

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
  connect: () => Promise<void>;
  setRealMode: (on: boolean) => Promise<void>;
  bindWallet: () => Promise<boolean>;
  approveIntent: (intent: RealIntent) => Promise<void>;
  cancelIntent: (intent: RealIntent) => Promise<void>;
  refreshIntents: () => Promise<void>;
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

  const available = hasInjectedWallet();
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
    sync();
    const provider = (globalThis as {
      ethereum?: { on?: (e: string, h: () => void) => void; removeListener?: (e: string, h: () => void) => void };
    }).ethereum;
    const onChange = () => { sync(); };
    provider?.on?.('accountsChanged', onChange);
    provider?.on?.('chainChanged', onChange);
    return () => {
      cancelled = true;
      provider?.removeListener?.('accountsChanged', onChange);
      provider?.removeListener?.('chainChanged', onChange);
    };
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
      await api.realIntentStatus(intent.id, 'active', claimToken);
      claimed = true;

      const built = await api.realSwapTx({ intentId: intent.id, from: address, chain: intent.chainId });

      // The router is the only contract we will ever grant an allowance to.
      // A response pointing elsewhere is refused BEFORE MetaMask is asked to
      // sign anything — this is the client half of the server's allow-list.
      if (String(built.to).toLowerCase() !== ALLOWED_ROUTER) {
        throw new Error('Router swap tidak dikenal — eksekusi dibatalkan demi keamanan');
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
      if (/user rejected|user denied|rejected the request/i.test(msg)) {
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
    intents, openIntents, approvingId, approveError,
    connect, setRealMode, bindWallet, approveIntent, cancelIntent, refreshIntents,
  }), [
    loaded, available, connected, address, chainId,
    realMode, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError,
    connect, setRealMode, bindWallet, approveIntent, cancelIntent, refreshIntents,
  ]);

  return <EvmWalletContext.Provider value={value}>{children}</EvmWalletContext.Provider>;
}

export function useEvmWallet(): EvmWalletState {
  const ctx = useContext(EvmWalletContext);
  if (!ctx) throw new Error('useEvmWallet must be used within EvmWalletProvider');
  return ctx;
}

export { switchChain };
