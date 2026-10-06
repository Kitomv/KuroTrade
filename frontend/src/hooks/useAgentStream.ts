// Realtime feed for the Agents page.
//
// Reads the SSE endpoint with `fetch` + a stream reader rather than
// `EventSource`. EventSource cannot set request headers, so the session token
// would have to travel in the query string — where it lands in proxy logs,
// access logs and browser devtools history. fetch keeps the existing Bearer
// header and the existing 401 handling, at the cost of parsing ~20 lines of
// framing by hand.
//
// Contract with the backend (backend/src/agentStream.js): full snapshots, one
// event per channel, no replay. A reconnect therefore costs nothing extra — the
// server sends the current state for all three channels on connect, so a gap
// while disconnected is closed by the next open rather than replayed.
//
// Consumers merge this with the existing usePolling fallback: when `connected`
// is false the page polls as before, so a stream failure degrades to the old
// behaviour instead of freezing the screen.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentReport, AutopilotConfig, LLMConfig } from '../api/client';

export interface AgentStreamResult {
  autopilot: AutopilotConfig | undefined;
  signals: AgentReport[] | undefined;
  llm: LLMConfig | undefined;
  /** True between a successful open and the first failure/close. */
  connected: boolean;
  lastEventAt: number | null;
  error: string | null;
  /**
   * A failure no retry can fix (4xx other than 401/429). The hook has stopped
   * and will not reconnect on its own; the polling fallback carries the page.
   */
  fatal: boolean;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Which failures are worth retrying.
 *
 * A 4xx that is neither 401 (session) nor 429 (too many open streams) is
 * permanent: the route does not exist, the request is malformed, or this
 * account may not open a stream. No amount of retrying fixes any of those.
 * That is not hypothetical — the 404 this feature shipped with produced one
 * request every 30s for as long as the tab stayed open, forever, with a
 * console error as the only output. 5xx is the server's problem and does clear
 * on its own, so it keeps the backoff.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Split a decoded SSE buffer into complete frames. Frames are separated by a
 * blank line; anything before the last separator is an incomplete tail and must
 * stay buffered for the next chunk.
 *
 * `\r\n` is folded to `\n` FIRST. A proxy that rewrites line endings turns the
 * frame terminator into `\r\n\r\n`, which contains no `\n\n` — splitting on
 * that alone never finds a boundary, the buffer grows forever, and the stream
 * stops delivering events with no error. Folding the whole buffer each time is
 * safe for a chunk boundary inside a `\r\n`: the lone `\r` stays in the tail
 * (it does not match `\r\n` yet) and is folded once the `\n` arrives.
 */
export function parseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

/**
 * Pull the event name and JSON payload out of one SSE frame. Comment lines
 * (`: ping`) are keep-alives and yield null; `id:`/`retry:` are ignored.
 */
export function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    // A truncated frame from a dropped connection — skip it rather than
    // tearing down a connection that is otherwise healthy.
    return null;
  }
}

export function useAgentStream(enabled = true): AgentStreamResult {
  const [state, setState] = useState<AgentStreamResult>({
    autopilot: undefined,
    signals: undefined,
    llm: undefined,
    connected: false,
    lastEventAt: null,
    error: null,
    fatal: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef(RECONNECT_MIN_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read in the reconnect `finally`, which must not schedule a retry after a
  // permanent failure — but a ref, because it is set inside the long-lived
  // loop and must not restart the connection when it changes.
  const fatalRef = useRef(false);
  // Read inside the long-lived loop, so the connect handler always sees the
  // current value without restarting the connection on every render.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Unmount is its own flag. Overloading `enabled` for it would strand the hook:
  // the cleanup would clear it, and if the effect re-ran (caller flips `enabled`,
  // or a StrictMode double-invoke) `connect()` would early-return forever.
  const disposedRef = useRef(false);
  const alive = () => enabledRef.current && !disposedRef.current;

  // One updater, so every write is safe after unmount and no handler has to
  // close over the previous snapshot. Each channel lands in its own slot, and
  // an event for one channel never clears the other two.
  const patch = useCallback((p: Partial<AgentStreamResult>) => {
    if (!enabledRef.current || disposedRef.current) return;
    setState((prev) => ({ ...prev, ...p }));
  }, []);

  const connect = useCallback(async () => {
    if (!alive()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = localStorage.getItem('trading_token');
      const res = await fetch('/api/agents/stream', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (res.status === 401) {
        // Same contract as api/client.ts `req()`: drop the dead session and
        // let App re-gate on the event instead of retrying forever.
        localStorage.removeItem('trading_token');
        dispatchEvent(new Event('trading-unauthorized'));
        return;
      }
      if (!res.ok || !res.body) {
        const message = `${res.status} ${res.statusText}`;
        if (!isRetryableStatus(res.status)) {
          // Permanent. Give up instead of reconnecting into it — see
          // isRetryableStatus. The fallback pollers already took over.
          fatalRef.current = true;
          patch({ connected: false, error: message, fatal: true });
          return;
        }
        throw new Error(message);
      }
      fatalRef.current = false;
      patch({ connected: true, error: null, fatal: false });
      retryRef.current = RECONNECT_MIN_MS;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const parsed = parseFrame(frame);
          if (!parsed) continue;
          const at = Date.now();
          if (parsed.event === 'autopilot') patch({ autopilot: parsed.data as AutopilotConfig, lastEventAt: at });
          else if (parsed.event === 'signals') patch({ signals: parsed.data as AgentReport[], lastEventAt: at });
          else if (parsed.event === 'llm') patch({ llm: parsed.data as LLMConfig, lastEventAt: at });
          else if (parsed.event === 'session-expired') {
            // The server re-checks the session on every heartbeat and closes the
            // stream when the token is revoked or past its TTL. Reconnecting
            // would only earn another 401, so tear the session down locally on
            // the same contract as a 401 on open.
            localStorage.removeItem('trading_token');
            dispatchEvent(new Event('trading-unauthorized'));
            return;
          }
        }
      }
      throw new Error('stream closed');
    } catch (e) {
      if (controller.signal.aborted) return;
      patch({ connected: false, error: e instanceof Error ? e.message : 'stream gagal' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      // A hidden tab must not reconnect. The `finally` runs even when the loop
      // exited via abort, and `return` in the catch does not skip it — without
      // this guard, hiding the tab aborts the stream and then immediately
      // schedules the reconnect that the visibility handler just cancelled,
      // leaving a connection open for a tab nobody is looking at.
      if (!alive() || document.hidden) return;
      // A permanent failure above already gave up. The `return` in the catch
      // does NOT skip `finally`, so this is the only place that can stop it.
      if (fatalRef.current) return;
      // Backoff, doubling, so a server restart does not turn into a reconnect
      // storm from every open tab.
      const delay = retryRef.current;
      retryRef.current = Math.min(RECONNECT_MAX_MS, retryRef.current * 2);
      timerRef.current = setTimeout(connect, delay);
    }
  }, [patch]);

  useEffect(() => {
    if (!enabled) return;
    disposedRef.current = false; // re-arm if this effect re-runs
    fatalRef.current = false; // a caller flipping `enabled` retries on purpose
    connect();
    return () => {
      disposedRef.current = true; // no state writes after unmount
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, connect]);

  // Tab visibility: an Agents tab nobody is looking at must not hold a stream
  // open (it pushes an autopilot snapshot every tick for every subscriber).
  // Closes on hide, reconnects immediately on show.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        abortRef.current?.abort();
        abortRef.current = null;
        patch({ connected: false });
      } else if (!abortRef.current && !timerRef.current && !fatalRef.current) {
        // A permanent failure stops for good, so showing the tab again must not
        // resurrect it — the page is on the polling fallback by then.
        retryRef.current = RECONNECT_MIN_MS;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [connect, patch]);

  return state;
}