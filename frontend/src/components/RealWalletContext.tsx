// Single source of truth for Real-Wallet mode AND the pending-intent engine.
// Mounted once inside the wallet provider gate (App), so connection state,
// bind status, and the auto-execute loop persist across page navigation —
// real wallet now lives here, not on Portfolio.
// API: useRealWallet() → realMode/realAuto/boundWallet/intents + bind/approve/cancel.
// User instruction: "mending buatin mode real wallet sendiri... taruh di atas akun"
// then "yang di porto hilangin real walletnya".
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { api, RealIntent } from '../api/client';

// `buffer` polyfill (vite alias) — provide the type so tsc accepts it.
declare const Buffer: { from(data: string, encoding: 'base64'): Uint8Array };

interface RealWalletState {
  loaded: boolean;
  realMode: boolean;
  realAuto: boolean;
  connected: boolean;
  boundWallet: string | null;
  isBound: boolean;
  binding: boolean;
  bindError: string;
  intents: RealIntent[];
  openIntents: RealIntent[];
  approvingId: string | null;
  approveError: string;
  setRealMode: (on: boolean) => Promise<void>;
  setRealAuto: (on: boolean) => Promise<void>;
  bindWallet: () => Promise<boolean>;
  approveIntent: (intent: RealIntent) => Promise<void>;
  cancelIntent: (intent: RealIntent) => Promise<void>;
  refreshIntents: () => Promise<void>;
}

const RealWalletContext = createContext<RealWalletState | null>(null);

export function RealWalletProvider({ children }: { children: React.ReactNode }) {
  const { connected, publicKey, signMessage, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [loaded, setLoaded] = useState(false);
  const [realMode, setRealModeState] = useState(false);
  // realAuto is retained in the context shape (banner/panel read it) but is
  // always false: real-wallet auto-execute was removed in favour of the
  // autopilot + hot wallet path. setRealAuto is a no-op kept for compile
  // compatibility with existing callers.
  const realAuto = false;
  const setRealAuto = useCallback(async (_on: boolean) => {
    console.warn('[RealWallet] setRealAuto is deprecated — use Hot Wallet Auto-Execute (Agents) instead.');
  }, []);
  const [boundWallet, setBoundWallet] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState('');
  const [intents, setIntents] = useState<RealIntent[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState('');

  const runningRef = useRef(false);                 // one swap in flight
  const skippedRef = useRef<Set<string>>(new Set()); // Phantom-rejected ids, skip for auto
  const attemptsRef = useRef<Map<string, number>>(new Map()); // per-intent retry counter (session only)
  const cooldownRef = useRef<Map<string, number>>(new Map()); // intentId -> next-allowed ts (ms)
  // Guards async chains that outlive this provider. approveIntent's `await`d
  // steps (claim → swap-tx → Phantom sign → simulate → send) can resolve after
  // the provider unmounted (user navigates / logs out mid-approval); writing
  // state then is at best a wasted setState, at worst a torn-state bug.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const pubKeyStr = publicKey?.toBase58() ?? null;
  const isBound = Boolean(pubKeyStr && boundWallet === pubKeyStr);
  
  // Load server mode/auto/bind state on mount + whenever the wallet account changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, a, b] = await Promise.all([
          api.realMode(),
          api.realAuto().catch(() => ({ realAuto: false })),
          api.boundWallet().catch(() => ({ boundWallet: null })),
        ]);
        if (cancelled) return;
        setRealModeState(m.realMode);
        setBoundWallet(b.boundWallet);
      } catch {}
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [pubKeyStr]);

  const refreshIntents = useCallback(async () => {
    try {
      const [list, a, b] = await Promise.all([
        api.realIntents(),
        api.realAuto().catch(() => ({ realAuto: false })),
        api.boundWallet().catch(() => ({ boundWallet: null })),
      ]);
      setIntents(list);
      setBoundWallet(b.boundWallet);
    } catch {}
  }, []);

  // Poll intents on an interval (always mounted → survives page changes).
  // Paused while the tab is hidden — three endpoints per tick with nobody
  // watching is what pushed the per-user rate limit over the edge.
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
    if (!publicKey || !signMessage) { setBindError('Wallet tidak mendukung signMessage'); return false; }
    setBinding(true);
    setBindError('');
    try {
      const { message } = await api.bindMessage(publicKey.toBase58());
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const signature = btoa(String.fromCharCode(...sigBytes));
      await api.bindWallet({ publicKey: publicKey.toBase58(), signature });
      setBoundWallet(publicKey.toBase58());
      return true;
    } catch (e: any) {
      setBindError((e?.message ?? 'Gagal bind wallet').slice(0, 200));
      return false;
    } finally {
      setBinding(false);
    }
  }, [publicKey, signMessage]);

  // Execute one intent: claim (M1) → server-built swap (M3) → Phantom sign →
  // simulate → send with preflight (M4) → mark done. Single source of truth.
  const approveIntent = useCallback(async (intent: RealIntent) => {
    if (!publicKey || !signTransaction || runningRef.current) return;
    runningRef.current = true;
    setApprovingId(intent.id);
    setApproveError('');
    const claimToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    let claimed = false;
    let sentSig: string | null = null; // tx broadcast → retrying could double-spend
    try {
      await api.realIntentStatus(intent.id, 'active', claimToken);
      claimed = true;
      const { swapTransaction } = await api.realSwapTx({ intentId: intent.id, userPublicKey: publicKey.toBase58() });
      const bytes = Uint8Array.from(Buffer.from(swapTransaction, 'base64'));
      const tx = VersionedTransaction.deserialize(bytes);
      const signed = await signTransaction(tx);
      const sim = await connection.simulateTransaction(signed);
      if (sim.value.err) throw new Error(`Simulasi gagal: ${JSON.stringify(sim.value.err).slice(0, 160)}`);
      const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 2 });
      sentSig = sig;
      await connection.confirmTransaction(sig, 'confirmed');
      await api.realIntentStatus(intent.id, 'done', claimToken);
      attemptsRef.current.delete(intent.id);
      cooldownRef.current.delete(intent.id);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        skippedRef.current.add(intent.id); // user said no — don't auto-retry
      } else if (sentSig) {
        // CRITICAL: the tx is already broadcast. Re-opening the intent would let
        // the auto-execute loop send the SAME trade again → double-spend of real
        // funds. Mark done instead; the user verifies on Solscan.
        try { await api.realIntentStatus(intent.id, 'done', claimToken); } catch {}
        if (mountedRef.current) {
          setApproveError(`Tx terkirim tapi belum terkonfirmasi (${sentSig.slice(0, 10)}…). Cek Solscan — intent ditandai selesai untuk mencegah eksekusi dobel.`);
          refreshIntents();
        }
        return;
      } else {
        // A 4xx is PERMANENT: the server rejected the request itself (wrong
        // network, bad intent, missing route). Retrying can never succeed, so
        // skip the intent outright — otherwise the loop hammers the API until
        // it 429s and the real error is buried in rate-limit noise.
        const status = (e as { status?: number })?.status;
        const permanent = typeof status === 'number' && status >= 400 && status < 500;
        if (permanent) {
          skippedRef.current.add(intent.id);
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
        // Back off between retries: the intent is reopened as 'open' below, and
        // without this the auto-execute effect re-fires immediately (openIntents
        // is a fresh array) → a sub-second claim/reopen burst hammering the API.
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
  }, [publicKey, signTransaction, connection, refreshIntents]);

  const cancelIntent = useCallback(async (intent: RealIntent) => {
    try {
      await api.realIntentStatus(intent.id, 'cancelled');
      skippedRef.current.delete(intent.id);
      attemptsRef.current.delete(intent.id);
      cooldownRef.current.delete(intent.id);
      if (mountedRef.current) await refreshIntents();
    } catch {}
  }, [refreshIntents]);

  const openIntents = useMemo(() => intents.filter((i) => i.status === 'open'), [intents]);

  // Auto-execute loop: only when real mode + auto + bound + secure origin. Runs
  // here (not in a page component) so it survives navigation and panel closes.
  // Honors the per-intent backoff so a deterministically-failing intent can't
  // spin the claim/reopen cycle at sub-second speed.
  // Auto-execute via Phantom REMOVED — execution is handled exclusively by the
  // autopilot + hot wallet (server-side signing). The old loop that auto-called
  // approveIntent() on every open intent is deliberately gone: it required a
  // Phantom popup per trade anyway, which is exactly what the hot wallet solves.

  const value = useMemo<RealWalletState>(() => ({
    loaded, realMode, realAuto, connected, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError,
    setRealMode, setRealAuto, bindWallet, approveIntent, cancelIntent, refreshIntents,
  }), [loaded, realMode, realAuto, connected, boundWallet, isBound, binding, bindError,
    intents, openIntents, approvingId, approveError,
    setRealMode, setRealAuto, bindWallet, approveIntent, cancelIntent, refreshIntents]);

  return <RealWalletContext.Provider value={value}>{children}</RealWalletContext.Provider>;
}

export function useRealWallet(): RealWalletState {
  const ctx = useContext(RealWalletContext);
  if (!ctx) throw new Error('useRealWallet must be used within RealWalletProvider');
  return ctx;
}
