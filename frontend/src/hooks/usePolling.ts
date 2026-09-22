// Lightweight polling hook with stale tracking — `ponytail:` swap to WebSocket
// when price stream is needed. Never overlaps ticks: if a request is still in
// flight when the next tick fires, that tick is skipped — a slow backend can't
// queue up fetches and saturate the connection pool. On any tick failure `stale`
// flips true and clears on the next success, so pages can surface a "backend
// lambat" indicator instead of silently showing frozen numbers.
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
): PollingResult<T> {
  const [data, setData] = useState<T>();
  const [stale, setStale] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const runningRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (runningRef.current) return; // skip while previous tick still in flight
      runningRef.current = true;
      Promise.resolve(fnRef.current())
        .then((r) => { if (!cancelled) { setData(r); setStale(false); } })
        .catch(() => { if (!cancelled) setStale(true); })
        .finally(() => { runningRef.current = false; });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, stale };
}