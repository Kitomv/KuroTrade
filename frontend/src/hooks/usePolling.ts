// Lightweight polling hook with stale tracking — `ponytail:` swap to WebSocket
// when price stream is needed. Never overlaps ticks: if a request is still in
// flight when the next tick fires, that tick is skipped — a slow backend can't
// queue up fetches and saturate the connection pool. On any tick failure `stale`
// flips true and clears on the next success, so pages can surface a "backend
// lambat" indicator instead of silently showing frozen numbers.
//
// Pauses while the browser tab is hidden (document.hidden) and fires one
// immediate tick when it becomes visible again. Every poller here ultimately
// costs either upstream API quota or LLM tokens on the backend, and a
// backgrounded tab polling /api/agents/signals was still buying Bull/Bear
// scans. User instruction: "pause semua polling saat tab hidden".
//
// `enabled` (default true) switches polling off entirely. The Agents page uses
// it to run these four pollers ONLY while its SSE stream is down — deps alone
// cannot do this, because the effect always starts on mount and on any deps
// change; it never stops. Flipping enabled true fires one immediate tick, so a
// dropped stream is caught up on the first visible frame.
//
// API change for callers: returns `{ data, stale }` (was `data`). Pages do
// `const p = usePolling(...)` then `p.data` / `p.stale`.
// Importers/callers: Overview, Trending, Watchlist, Chart, Trade, Portfolio,
// Agents, Leaderboard (all `const x = usePolling(...)` — now `p.data`/`p.stale`).
// User instruction: "improve user experience:ALL" — surface silent polling stalls.

import { useEffect, useRef, useState } from 'react';

export interface PollingResult<T> {
  data: T | undefined;
  stale: boolean;
}

export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs = 15_000,
  deps: unknown[] = [],
  enabled = true,
): PollingResult<T> {
  const [data, setData] = useState<T>();
  const [stale, setStale] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const runningRef = useRef(false);
  // A fetch that never settles (proxy wedged, TCP hung) would hold runningRef
  // forever → every later tick is skipped, numbers freeze, and `stale` never
  // flips. A hard ceiling per tick lets the loop release itself.
  const TICK_TIMEOUT_MS = 45_000;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (runningRef.current) return; // skip while previous tick still in flight
      runningRef.current = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const release = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        runningRef.current = false;
      };
      timer = setTimeout(() => {
        if (!cancelled) setStale(true); // a hung tick is a stale condition
        release();
      }, TICK_TIMEOUT_MS);
      Promise.resolve(fnRef.current())
        .then((r) => { if (!cancelled) { setData(r); setStale(false); } })
        .catch(() => { if (!cancelled) setStale(true); })
        .finally(release);
    };
    const start = () => {
      if (id || cancelled || document.hidden) return;
      tick();
      id = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (id) { clearInterval(id); id = null; }
    };
    // Tab visibility: stop paying for polls nobody can see; refresh once on
    // return so the first visible frame is current instead of stale.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { data, stale };
}