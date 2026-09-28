import { useState, useEffect, useRef, useCallback } from 'react';
import { api, AgentReport, AutopilotConfig, LLMConfig, LLMProviderEntry } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { EquityChart } from '../components/EquityChart';
import { IconBot, IconBolt, IconChartBar, IconChartLine, IconGear, IconKey, IconLock, IconPower, IconRocket, IconShield, IconSparkles, IconTrendingDown, IconTrendingUp } from '../components/Icons';
import { fmt } from '../lib/format';
import { Modal } from '../components/Modal';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmDialog';
import { StaleBadge } from '../components/StaleBadge';
import { RealTradeForm } from '../components/RealTradeForm';
import { useEvmWallet } from '../components/EvmWalletContext';
import { shortAddr } from '../lib/evm';
import type { Page, AutopilotGuardedPosition } from '../api/client';

const logTags = ['ALL', 'BUY', 'TP', 'SELL', 'SL', 'WARN', 'SCAN', 'ROTATE', 'CONFIG'] as const;
type LogTag = (typeof logTags)[number];

export function Agents({ onNavigate }: { onNavigate?: (p: Page) => void }) {
  const { connected, isBound, boundWallet, openIntents } = useEvmWallet();
  const [tokenAddr, setTokenAddr] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [report, setReport] = useState<AgentReport | null>(null);
  // Real-mode swap prefill: the AI-Debate result's "Eksekusi" button opens
  // RealTradeForm with this token/amount instead of placing a virtual order.
  const [radarTrade, setRadarTrade] = useState<AgentReport | null>(null);
  const [err, setErr] = useState('');
  const [tradeSuccess, setTradeSuccess] = useState('');
  const [executingTrade, setExecutingTrade] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showLLMModal, setShowLLMModal] = useState(false);
  const [tagFilter, setTagFilter] = useState<LogTag>('ALL');
  const [logSearch, setLogSearch] = useState('');
  // Auto-follow the tail only while the reader is already at the bottom.
  // Unconditionally scrolling on every new line made the feed impossible to
  // read: the guardian logs every 5s, so any attempt to scroll back was
  // yanked forward again before the line could be finished.
  const [followLogs, setFollowLogs] = useState(true);
  const [unseenLogs, setUnseenLogs] = useState(0);
  const toast = useToast();
  const confirmAction = useConfirm();

  // Fast polling for Real-Time Auto-Pilot Terminal & Guardian (relaxed to 4s to cut CPU/network load)
  const autopilotP = usePolling(() => api.getAutopilot(), 4_000, []);
  const watchlistP = usePolling(() => api.watchlist(), 10_000, []);
  const scannedP = usePolling(() => api.agentSignals(6), 5_000, []);
  const llmP = usePolling(() => api.getLLMConfig(), 10_000, []);
  const autopilot = autopilotP.data;
  const watchlist = watchlistP.data;
  const scannedSignals = scannedP.data;
  const llmInfo = llmP.data;

  // Form config state
  const [takeProfit, setTakeProfit] = useState(15);
  const [stopLoss, setStopLoss] = useState(7);
  const [trailingStop, setTrailingStop] = useState(4);
  const [trailingTrigger, setTrailingTrigger] = useState(6);
  const [moonbagX, setMoonbagX] = useState(2);
  const [maxPositions, setMaxPositions] = useState(3);
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [minConf, setMinConf] = useState(75);
  const [rotateAfterHours, setRotateAfterHours] = useState(24);
  const [maxExposurePct, setMaxExposurePct] = useState(80);
  const [agentMode, setAgentMode] = useState<'blend' | 'deterministic' | 'llm'>('blend');
  // LLM / scan performance knobs (new)
  const [llmTimeoutMs, setLlmTimeoutMs] = useState(30000);
  const [scanConcurrency, setScanConcurrency] = useState(3);
  const [enableLeadSynthesis, setEnableLeadSynthesis] = useState(true);
  // Real-wallet auto-approve switch in the Guardian drawer (polled + toggleable).
  const [realMode, setRealMode] = useState(false);
  // Real-wallet auto-approve was removed (autopilot + hot wallet execute now).
  // No local realAuto state needed — realMode only.

  // LLM Modal State
  // LLM Modal State — multi-provider stack (fallback chain / role routing)
  const [llmEntries, setLlmEntries] = useState([
    { provider: '9router', apiKey: '', model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.9router.com/v1', role: null as string | null },
  ]);
  const [savingLLM, setSavingLLM] = useState(false);
  // Per-entry: fetched model list (combo) + last connection-test result.
  const [llmModels, setLlmModels] = useState<Record<number, string[]>>({});
  const [llmBusy, setLlmBusy] = useState<Record<number, 'models' | 'test' | undefined>>({});
  const [llmTestResult, setLlmTestResult] = useState<Record<number, { ok: boolean; text: string } | undefined>>({});

  const logsEndRef = useRef<HTMLDivElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);

  // Re-engage follow mode once the reader scrolls back to the bottom.
  const handleLogScroll = useCallback(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom && !followLogs) {
      setFollowLogs(true);
      setUnseenLogs(0);
    } else if (!atBottom && followLogs) {
      setFollowLogs(false);
    }
  }, [followLogs]);

  useEffect(() => {
    if (autopilot) {
      setTakeProfit(autopilot.takeProfitPct ?? 15);
      setStopLoss(autopilot.stopLossPct ?? 7);
      setTrailingStop(autopilot.trailingStopPct ?? 4);
      setTrailingTrigger(autopilot.trailingTriggerPct ?? 6);
      setMoonbagX(autopilot.moonbagX ?? 2);
      setMaxPositions(autopilot.maxOpenPositions ?? 3);
      setRiskLevel(autopilot.riskLevel ?? 'medium');
      setMinConf(autopilot.minConfidence ?? 75);
      setRotateAfterHours(autopilot.rotateAfterHours ?? 24);
      setMaxExposurePct(autopilot.maxExposurePct ?? 80);
      setAgentMode(autopilot.agentMode ?? 'blend');
      setLlmTimeoutMs(autopilot.llmTimeoutMs ?? 30000);
      setScanConcurrency(autopilot.scanConcurrency ?? 3);
      setEnableLeadSynthesis(autopilot.enableLeadSynthesis !== false);
    }
  }, [autopilot]);

  // Oldest first, newest at the BOTTOM — like a real terminal/console. The
  // backend unshifts (newest at index 0) and caps the buffer with pop(), so
  // array order alone is not a stable sort: mixed-age entries can arrive out of
  // order after a restart. Sort by ts ascending explicitly, which also keeps
  // `logsEndRef` anchored to the newest line (it is the last child).
  const visibleLogs = (autopilot?.logs ?? [])
    .filter((l) => tagFilter === 'ALL' || l.tag === tagFilter)
    .filter((l) => {
      const q = logSearch.trim().toLowerCase();
      if (!q) return true;
      // Search the message AND the structured details — a symbol often lives
      // in details only, so a message-only search would miss the intent rows.
      const hay = `${l.msg} ${l.details ? JSON.stringify(l.details) : ''}`.toLowerCase();
      return hay.includes(q);
    })
    .slice()
    .sort((a, b) => a.ts - b.ts);

  // Real wallet mode + auto-approve status (15s poll; Portfolio toggle reflects
  // within 15s). Paused while hidden — this page already polls 4 other
  // endpoints, and an unwatched tab must not keep spending the rate limit.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [m] = await Promise.all([api.realMode()]);
        if (cancelled) return;
        setRealMode(m.realMode);
      } catch {}
    };
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id || cancelled) return;
      load();
      id = setInterval(load, 15_000);
    };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  // Keyed on the RAW log count, not the filtered length: changing a filter or
  // the search box changes `visibleLogs.length` without any new activity, which
  // would inflate the "N baru" badge with lines that are not actually new.
  // `seenCountRef` records how many entries were on screen when the reader was
  // last at the bottom, so the badge counts exactly the difference — toggling
  // follow mode alone must not fabricate an unread line.
  const rawLogCount = autopilot?.logs?.length ?? 0;
  const seenCountRef = useRef(0);
  useEffect(() => {
    if (followLogs) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      seenCountRef.current = rawLogCount;
      setUnseenLogs(0);
    } else {
      setUnseenLogs(Math.max(0, rawLogCount - seenCountRef.current));
    }
  }, [rawLogCount, followLogs]);

  useEffect(() => {
    if (llmInfo) {
      // Prefer entries[] if backend sent it; otherwise fall back to single-entry shape.
      if (llmInfo.entries?.length) {
        setLlmEntries(llmInfo.entries.map((e) => ({
          provider: e.provider,
          apiKey: '',
          model: e.model,
          baseUrl: e.baseUrl ?? '',
          role: e.role,
        })));
      } else {
        setLlmEntries([{
          provider: (llmInfo.provider ?? '9router') as any,
          apiKey: '',
          model: llmInfo.model ?? 'claude-3-5-sonnet-20241022',
          baseUrl: llmInfo.baseUrl ?? 'https://api.9router.com/v1',
          role: null,
        }]);
      }
    }
  }, [llmInfo?.entries?.length, llmInfo?.provider, llmInfo?.baseUrl]);

  const handleAnalyze = async (addr: string) => {
    if (!addr.trim()) return;
    setAnalyzing(true);
    setErr('');
    setTradeSuccess('');
    try {
      const res = await api.analyzeToken(addr.trim());
      setReport(res);
      setTokenAddr(addr.trim());
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal menganalisis token';
      setErr(message);
      setReport(null);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleToggleAutopilot = async () => {
    if (!autopilot) return;
    try {
      await api.setAutopilot({ enabled: !autopilot.enabled });
    } catch {
      setErr('Gagal mengubah status autopilot');
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.setAutopilot({
        takeProfitPct: Number(takeProfit),
        stopLossPct: Number(stopLoss),
        trailingStopPct: Number(trailingStop),
        trailingTriggerPct: Number(trailingTrigger),
        moonbagX: Number(moonbagX),
        maxOpenPositions: Number(maxPositions),
        riskLevel,
        minConfidence: Number(minConf),
        rotateAfterHours: Number(rotateAfterHours),
        maxExposurePct: Number(maxExposurePct),
        agentMode,
        llmTimeoutMs: Number(llmTimeoutMs),
        scanConcurrency: Number(scanConcurrency),
        enableLeadSynthesis,
      });
      setShowConfig(false);
    } catch {
      setErr('Gagal menyimpan konfigurasi autopilot');
    }
  };

  const handleSaveLLM = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingLLM(true);
    try {
      // Send the full stack; entries without a typed key keep the stored key
      // (backend treats a missing apiKey as "leave existing").
      const payload: LLMProviderEntry[] = llmEntries.map((entry) => ({
        provider: entry.provider as LLMProviderEntry['provider'],
        ...(entry.apiKey.trim() ? { apiKey: entry.apiKey } : {}),
        model: entry.model,
        baseUrl: entry.provider === '9router' || entry.provider === 'custom' ? entry.baseUrl : undefined,
        role: (entry.role as LLMProviderEntry['role']) ?? null,
      }));
      await api.setLLMConfig(payload);
      setLlmEntries((prev) => prev.map((p) => ({ ...p, apiKey: '' })));
      setLlmTestResult({});
      setShowLLMModal(false);
      toast.showToast('Konfigurasi LLM tersimpan', 'success');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal menyimpan konfigurasi LLM';
      setErr(message.slice(0, 200));
      toast.showToast(message.slice(0, 120), 'error');
    } finally {
      setSavingLLM(false);
    }
  };

  // Fetch /v1/models for one entry (9router-style combo) — preview params supported.
  const handleLoadModels = async (idx: number) => {
    const entry = llmEntries[idx];
    if (!entry) return;
    setLlmBusy((b) => ({ ...b, [idx]: 'models' }));
    setLlmTestResult((r) => ({ ...r, [idx]: undefined }));
    try {
      const { models } = await api.llmModels(entry.apiKey.trim() ? { provider: entry.provider, baseUrl: entry.baseUrl, apiKey: entry.apiKey } : undefined);
      setLlmModels((m) => ({ ...m, [idx]: models }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal memuat model';
      setLlmModels((m) => ({ ...m, [idx]: [] }));
      setLlmTestResult((r) => ({ ...r, [idx]: { ok: false, text: `❌ Muat model: ${message.slice(0, 180)}` } }));
    } finally {
      setLlmBusy((b) => ({ ...b, [idx]: undefined }));
    }
  };

  // Probe koneksi (models dulu, fallback chat ping) — tampilkan pesan verbatim.
  const handleTestLLM = async (idx: number) => {
    const entry = llmEntries[idx];
    if (!entry) return;
    setLlmBusy((b) => ({ ...b, [idx]: 'test' }));
    try {
      const r = await api.llmTest(entry.apiKey.trim() ? { provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl, apiKey: entry.apiKey } : {});
      if (r.ok) {
        const detail = r.via === 'models'
          ? `${r.modelCount} model · ${r.latencyMs}ms`
          : r.sample ? `sample: ${r.sample} · ${r.latencyMs}ms` : `${r.latencyMs}ms`;
        setLlmTestResult((prev) => ({ ...prev, [idx]: { ok: true, text: `✅ OK · ${detail}` } }));
        const models = r.models;
        if (models?.length) setLlmModels((m) => ({ ...m, [idx]: models }));
      } else {
        setLlmTestResult((prev) => ({ ...prev, [idx]: { ok: false, text: `❌ ${r.error || r.modelsError || 'Gagal koneksi'} · ${r.latencyMs}ms` } }));
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal tes koneksi';
      setLlmTestResult((prev) => ({ ...prev, [idx]: { ok: false, text: `❌ ${message.slice(0, 180)}` } }));
    } finally {
      setLlmBusy((b) => ({ ...b, [idx]: undefined }));
    }
  };

  const handleClearLogs = async () => {
    try {
      await api.clearAutopilotLogs();
    } catch {}
  };

  const handleExecuteAIOrder = async () => {
    if (!report) return;
    const { token, verdict } = report;
    if (verdict.signal === 'HOLD') {
      setErr('Sinyal saat ini HOLD. Tidak disarankan mengeksekusi order.');
      return;
    }
    if (verdict.signal === 'SELL' && verdict.recommendedTokens <= 0) {
      setErr('Tidak ada posisi token ini di portfolio untuk dieksekusi.');
      return;
    }

    const side = verdict.signal.includes('BUY') ? 'buy' : 'sell';
    const sideLabel = side === 'buy' ? 'BUY' : 'SELL';

    if (realMode) {
      // Real mode → open RealTradeForm modal with token/amount prefilled.
      // RealTradeForm handles quote → intent → MetaMask sign → broadcast.
      setRadarTrade({
        ...report,
        token: { ...token, symbol: token.symbol, name: token.name, chainId: token.chainId, priceUsd: verdict.entryPrice },
      });
      return;
    }

    // Virtual mode → existing virtual order flow.
    const ok = await confirmAction({
      title: `Eksekusi ${sideLabel} ${token.symbol}`,
      message: `Eksekusi order virtual ${sideLabel} ${token.symbol} @ $${verdict.entryPrice} ($${verdict.recommendedUsd} USDC)?`,
      confirmLabel: `Eksekusi ${sideLabel}`,
      danger: side === 'sell',
    });
    if (!ok) return;

    setExecutingTrade(true);
    setErr('');
    setTradeSuccess('');

    try {
      const order = await api.marketOrder({
        side,
        tokenAddress: token.address,
        chainId: token.chainId,
        symbol: token.symbol,
        name: token.name,
        usdAmount: verdict.recommendedUsd,
        tokenAmount: verdict.recommendedTokens,
      });
      setTradeSuccess(`Sukses dieksekusi oleh AI Agent! Order ${side.toUpperCase()} ${order.amount.toFixed(4)} ${token.symbol} @ $${order.price.toFixed(4)}`);
      toast.showToast(`Order ${side.toUpperCase()} ${token.symbol} dieksekusi`, 'success');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal mengeksekusi order virtual';
      setErr(message);
      toast.showToast(message, 'error');
    } finally {
      setExecutingTrade(false);
    }
  };

  const ap: AutopilotConfig = autopilot ?? {
    enabled: false,
    status: 'IDLE',
    riskLevel: 'medium',
    minConfidence: 75,
    takeProfitPct: 15,
    stopLossPct: 7,
    maxOpenPositions: 3,
    lastScanAt: null,
    guardedPositionsCount: 0,
    guardedPositions: [],
    stats: { totalScans: 0, totalTrades: 0, profitableTrades: 0, totalProfitUsd: 0, winRate: 0 },
    logs: [],
  };

  const isRunning = ap.enabled;
  const statusColor = isRunning
    ? ap.status === 'SCANNING'
      ? 'var(--accent)'
      : ap.status === 'GUARDIAN'
      ? 'var(--accent2)'
      : 'var(--up)'
    : 'var(--muted)';

  const activeLLM: LLMConfig = llmInfo ?? {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    hasKey: false,
    maskedKey: '',
  };

  return (
    <>
      {/* Top Header */}
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h1>AI Trading Desk</h1>
            <StaleBadge stale={autopilotP.stale || scannedP.stale || llmP.stale} />
            <span
              className="chip"
              style={{
                background: activeLLM.hasKey ? 'var(--accent-dim)' : 'var(--panel-2)',
                color: activeLLM.hasKey ? 'var(--accent)' : 'var(--muted)',
                border: `1px solid ${activeLLM.hasKey ? 'var(--accent)' : 'var(--border)'}`,
                cursor: 'pointer',
              }}
              onClick={() => setShowLLMModal(true)}
              title="Klik untuk ganti model LLM atau API Key"
            >
              {activeLLM.hasKey ? `⚡ ${activeLLM.provider.toUpperCase()} (${activeLLM.model})` : '⚡ Quantitative Fallback (Set API Key)'}
            </span>
          </div>
          <p>Multi-Agent LLM Debate Engine & Autonomous Quantitative Position Guardian on DexScreener Data.</p>
        </div>

        {/* Master Switch & Config Buttons */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            className="btn"
            onClick={() => setShowLLMModal(true)}
            style={{ fontSize: 13 }}
          >
            <IconKey size={14} /> Model AI & Key
          </button>
          <button
            className="btn"
            onClick={() => setShowConfig(!showConfig)}
            style={{ fontSize: 13, background: showConfig ? 'var(--panel-2)' : 'transparent' }}
          >
            <IconGear size={14} /> Atur Guardian (TP/SL)
          </button>
          <button
            className="btn"
            style={{
              background: isRunning ? 'var(--down-bg)' : 'var(--up-bg)',
              color: isRunning ? 'var(--down)' : 'var(--up)',
              borderColor: isRunning ? 'var(--down)' : 'var(--up)',
              fontWeight: 700,
              padding: '10px 20px',
              fontSize: 14,
            }}
            onClick={handleToggleAutopilot}
          >
            {isRunning ? <><IconPower size={14} /> Matikan Auto-Pilot</> : <><IconBolt size={14} /> Nyalakan Auto-Pilot</>}
          </button>
        </div>
      </div>

      {/* LLM Model Setup Modal */}
      {showLLMModal && (
        <Modal title={<><IconBot size={16} /> Konfigurasi Model AI (Cloud LLM)</>} onClose={() => setShowLLMModal(false)} maxWidth={480}>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
            Multi-LLM: susun beberapa provider sebagai fallback chain (primary → fallback) dan/atau role routing
            (Bull / Bear / Lead bisa pakai model berbeda). Kosongkan api key pada baris fallback yang tidak dipakai.
          </p>

          <form onSubmit={handleSaveLLM}>
              {llmEntries.map((entry, idx) => (
                <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {idx === 0 ? 'PRIMARY' : `FALLBACK ${idx}`}
                    </strong>
                    {idx > 0 && (
                      <button type="button" className="btn icon" style={{ minHeight: 26, minWidth: 26, padding: 2, fontSize: 11 }}
                        onClick={() => setLlmEntries((prev) => prev.filter((_, i) => i !== idx))}>
                        ✕
                      </button>
                    )}
                  </div>

                  <div className="grid-2" style={{ marginBottom: 8 }}>
                    <select
                      className="input"
                      style={{ width: '100%' }}
                      value={entry.provider}
                      onChange={(e) => {
                        const p = e.target.value as any;
                        const defaults: Record<string, { model: string; baseUrl?: string }> = {
                          '9router': { model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.9router.com/v1' },
                          anthropic: { model: 'claude-3-5-sonnet-20241022' },
                          openai: { model: 'gpt-4o-mini' },
                          deepseek: { model: 'deepseek-chat' },
                          openrouter: { model: 'anthropic/claude-3.5-sonnet' },
                          custom: { model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.openai.com/v1' },
                        };
                        setLlmEntries((prev) => prev.map((x, i) => i === idx ? { ...x, provider: p, ...defaults[p] } : x));
                      }}
                    >
                      <option value="9router">9router (Gateway)</option>
                      <option value="anthropic">Anthropic (Claude)</option>
                      <option value="openai">OpenAI (GPT)</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="custom">Custom Endpoint</option>
                    </select>
                    <select
                      className="input"
                      style={{ width: '100%' }}
                      value={entry.role ?? ''}
                      onChange={(e) => {
                        const r = e.target.value || null;
                        setLlmEntries((prev) => prev.map((x, i) => i === idx ? { ...x, role: r } : x));
                      }}
                    >
                      <option value="">Role: Semua (fallback)</option>
                      <option value="bull">Role: Bull only</option>
                      <option value="bear">Role: Bear only</option>
                      <option value="lead">Role: Lead only</option>
                    </select>
                  </div>

                  {(entry.provider === '9router' || entry.provider === 'custom') && (
                    <input
                      type="text"
                      className="input"
                      style={{ width: '100%', marginBottom: 8 }}
                      value={entry.baseUrl}
                      onChange={(e) => setLlmEntries((prev) => prev.map((x, i) => i === idx ? { ...x, baseUrl: e.target.value } : x))}
                      placeholder="http://localhost:20128/v1 (9router lokal) atau https://api.9router.com/v1"
                    />
                  )}

                  {/* Model combo — datalist dari /v1/models (9router-style) + input bebas */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1, minWidth: 0 }}
                      value={entry.model}
                      onChange={(e) => setLlmEntries((prev) => prev.map((x, i) => i === idx ? { ...x, model: e.target.value } : x))}
                      placeholder="nama model (kc/nvidia/…:free / gpt-4o / deepseek-chat)"
                      list={`llm-models-${idx}`}
                      required
                    />
                    <datalist id={`llm-models-${idx}`}>
                      {(llmModels[idx] ?? []).map((m) => <option key={m} value={m} />)}
                    </datalist>
                    <button
                      type="button"
                      className="btn"
                      style={{ minHeight: 44, fontSize: 12, whiteSpace: 'nowrap' }}
                      disabled={llmBusy[idx] === 'models'}
                      onClick={() => handleLoadModels(idx)}
                      title="Ambil daftar model dari endpoint /v1/models"
                    >
                      {llmBusy[idx] === 'models' ? '…' : `Muat Model${llmModels[idx]?.length ? ` (${llmModels[idx].length})` : ''}`}
                    </button>
                  </div>

                  <input
                    type="password"
                    className="input"
                    style={{ width: '100%' }}
                    value={entry.apiKey}
                    onChange={(e) => setLlmEntries((prev) => prev.map((x, i) => i === idx ? { ...x, apiKey: e.target.value } : x))}
                    placeholder={llmInfo?.entries?.[idx]?.hasKey ? `Tersimpan: ${llmInfo.entries[idx].maskedKey} — isi untuk ganti` : 'API key (kosongkan jika tidak dipakai)'}
                  />

                  {/* Tes koneksi — verifikasi key/baseUrl/model tanpa jalankan autopilot */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn"
                      style={{ minHeight: 32, padding: '4px 12px', fontSize: 12 }}
                      disabled={llmBusy[idx] === 'test'}
                      onClick={() => handleTestLLM(idx)}
                    >
                      {llmBusy[idx] === 'test' ? 'Menguji…' : 'Tes Koneksi'}
                    </button>
                    {llmTestResult[idx] && (
                      <span style={{ fontSize: 12, color: llmTestResult[idx]!.ok ? 'var(--up)' : 'var(--down)', wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
                        {llmTestResult[idx]!.text}
                      </span>
                    )}
                  </div>
                </div>
              ))}

              <button
                type="button"
                className="btn"
                style={{ width: '100%', marginBottom: 14, fontSize: 12, minHeight: 36 }}
                onClick={() => setLlmEntries((prev) => [...prev, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: '', role: null }])}
              >
                + Tambah Provider (Fallback / Role)
              </button>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowLLMModal(false)}
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  style={{ flex: 1 }}
                  disabled={savingLLM}
                >
                  {savingLLM ? 'Menyimpan…' : 'Simpan & Terapkan'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {/* Real-Time Telemetry Bar */}
      <div className={`card${isRunning ? ' card-neon' : ''}`} style={{ padding: '16px 22px', marginBottom: 20, border: isRunning ? '1px solid var(--accent)' : '1px solid var(--border)', boxShadow: isRunning ? '0 0 20px var(--accent-glow)' : undefined }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span
              className="dot"
              style={{
                background: statusColor,
                boxShadow: isRunning ? `0 0 16px ${statusColor}` : 'none',
                width: 12,
                height: 12,
              }}
            />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 16, fontFamily: 'var(--font-heading)' }}>
                  {isRunning ? `AUTONOMOUS MONITORING [${ap.status}]` : 'AUTONOMOUS AGENT STANDBY'}
                </strong>
                <span className="chip" style={{ background: isRunning ? 'var(--up-bg)' : 'var(--panel-2)', color: isRunning ? 'var(--up)' : 'var(--muted)' }}>
                  {isRunning ? <><IconBolt size={12} /> 5s Realtime Loop</> : 'Off'}
                </span>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                Guardian TP: +{ap.takeProfitPct}% | SL: -{ap.stopLossPct}% | Risk: {ap.riskLevel.toUpperCase()} | Max Slots: {ap.maxOpenPositions}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600 }}>Posisi Diproteksi</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: ap.guardedPositionsCount > 0 ? 'var(--accent2)' : 'var(--text)' }}>
                {ap.guardedPositionsCount} Token
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600 }}>Total Siklus Scan</div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{ap.stats?.totalScans ?? 0}x</div>
            </div>
          </div>
        </div>

        {/* Configuration Drawer */}
        {showConfig && (
          <form onSubmit={handleSaveConfig} style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Auto Take-Profit (%)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={takeProfit} onChange={(e) => setTakeProfit(Number(e.target.value))} min={1} max={500} required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Auto Stop-Loss (%)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={stopLoss} onChange={(e) => setStopLoss(Number(e.target.value))} min={1} max={50} required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Trailing Stop-Loss (%)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={trailingStop} onChange={(e) => setTrailingStop(Number(e.target.value))} min={1} max={25} required title="Mengunci profit jika harga turun X% dari titik tertinggi" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Aktifkan Trailing Setelah Profit (%)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={trailingTrigger} onChange={(e) => setTrailingTrigger(Number(e.target.value))} min={1} max={100} required title="Trailing mulai aktif setelah harga naik X% dari harga beli" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Multiplier TP2 Moonbag (x)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={moonbagX} onChange={(e) => setMoonbagX(Number(e.target.value))} min={1} max={10} required title="Sisa posisi ditutup saat profit mencapai TP1 x multiplier" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Max Posisi Terbuka</label>
              <input type="number" className="input" style={{ width: '100%' }} value={maxPositions} onChange={(e) => setMaxPositions(Number(e.target.value))} min={1} max={10} required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Min AI Confidence (%)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={minConf} onChange={(e) => setMinConf(Number(e.target.value))} min={1} max={100} required title="Auto-Buy hanya saat sinyal STRONG_BUY & confidence >= nilai ini" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Rotasi Stagnant (jam)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={rotateAfterHours} onChange={(e) => setRotateAfterHours(Number(e.target.value))} min={1} max={168} required title="Posisi flat (-2%..+2%) lebih lama dari ini akan dijual saat slot penuh" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Max Exposure (%)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={maxExposurePct} onChange={(e) => setMaxExposurePct(Number(e.target.value))} min={10} max={100} required title="Batasi total nilai posisi + reserved terhadap total portofolio" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>LLM Timeout (ms)</label>
              <input type="number" className="input" style={{ width: '100%' }} value={llmTimeoutMs} onChange={(e) => setLlmTimeoutMs(Number(e.target.value))} min={5000} max={180000} step={1000} required title="Batas waktu per panggilan LLM (5-180s). Turunkan jika model antre lama membekukan tick." />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Scan Concurrency</label>
              <input type="number" className="input" style={{ width: '100%' }} value={scanConcurrency} onChange={(e) => setScanConcurrency(Number(e.target.value))} min={1} max={6} required title="Berapa token dianalisis paralel per scan (1-6). Lebih tinggi = lebih cepat, tapi lebih banyak LLM per tick." />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Lead Synthesis (LLM kata-sambutan)</label>
              <button
                type="button"
                className="btn"
                style={{ width: '100%', minHeight: 44, fontWeight: 700, fontSize: 12, background: enableLeadSynthesis ? 'var(--panel-2)' : 'transparent', borderColor: 'var(--border)', color: enableLeadSynthesis ? 'var(--text)' : 'var(--muted)' }}
                onClick={() => setEnableLeadSynthesis((v) => !v)}
                title="Panggilan LLM ketiga (Lead Trader) yang menulis kalimat keputusan. Matikan untuk hemat biaya — hanya di-skip saat sinyal HOLD."
              >
                {enableLeadSynthesis ? 'AKTIF (semua sinyal)' : 'HEMAT (skip saat HOLD)'}
              </button>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Agent Mode</label>
              <select className="input" style={{ width: '100%' }} value={agentMode} onChange={(e) => setAgentMode(e.target.value as 'blend' | 'deterministic' | 'llm')}>
                <option value="blend">Blend (LLM 60% + Quant 40%)</option>
                <option value="deterministic">Deterministic (hemat API, tanpa LLM)</option>
                <option value="llm">LLM Only (seperti sebelumnya)</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Level Risiko</label>
              <select className="input" style={{ width: '100%' }} value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as 'low' | 'medium' | 'high')}>
                <option value="low">Low (10% Saldo)</option>
                <option value="medium">Medium (20% Saldo)</option>
                <option value="high">High (35% Saldo)</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="submit" className="btn primary" style={{ width: '100%', minHeight: 44 }}>
                Simpan Aturan Guardian
              </button>
            </div>
          </form>
        )}
      </div>

      {/* KPI Monitoring Tiles */}
      <div className="kpi-grid">
        <div className="card kpi">
          <div className="label">Round Trip Selesai</div>
          <div className="value">{ap.stats?.totalTrades ?? 0} Order</div>
          <div className="sub">
            {realMode
              ? 'exit yang kamu approve di MetaMask'
              : 'round trip paper trading'}
          </div>
        </div>
        <div className="card kpi">
          <div className="label">Profit Realized</div>
          <div className="value" style={{ color: (ap.stats?.totalProfitUsd ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>
            {(ap.stats?.totalProfitUsd ?? 0) >= 0 ? '+' : ''}{fmt.usd(ap.stats?.totalProfitUsd ?? 0)}
          </div>
          <div className="sub">
            Win Rate {ap.stats?.winRate ?? 0}% · {ap.stats?.profitableTrades ?? 0}/{ap.stats?.totalTrades ?? 0} menang
          </div>
        </div>
        <div className="card kpi">
          <div className="label">Diproteksi Guardian</div>
          <div className="value" style={{ color: ap.guardedPositionsCount > 0 ? 'var(--accent2)' : 'var(--muted)' }}>
            {ap.guardedPositionsCount}
          </div>
          <div className="sub">
            {ap.guardedPositionsCount > 0
              ? `dari maks ${ap.maxOpenPositions ?? 3} slot · TP/SL otomatis`
              : 'belum ada posisi terbuka'}
          </div>
        </div>
        <div className="card kpi">
          <div className="label">AI Model Engine</div>
          <div className="value" style={{ color: 'var(--accent)', fontSize: 16 }}>
            {activeLLM.hasKey ? activeLLM.model : 'Deterministic Engine'}
          </div>
          <div className="sub">{activeLLM.hasKey ? `Cloud API (${activeLLM.provider})` : 'Quant Desk (On-Chain AI)'}</div>
        </div>
      </div>

      {/* Two-Column: Guarded Positions & Real-Time Cyberpunk Terminal.
          Class-based (not inline) so the ≤1024px query can stack it. */}
      <div className="responsive-two-col" style={{ marginBottom: 24 }}>
        {/* Guarded Positions Radar */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span><IconShield size={16} /> Posisi Diproteksi Realtime ({ap.guardedPositions?.length ?? 0})</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Auto TP/SL Monitor</span>
          </div>

          <div className="table-wrap" style={{ flex: 1 }}>
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="num">Harga Live</th>
                  <th className="num">PnL Realtime</th>
                  <th>Jarak Target</th>
                </tr>
              </thead>
              <tbody>
                {(ap.guardedPositions ?? []).map((p) => {
                  const isUp = p.pnlPct >= 0;
                  return (
                    <tr key={p.address}>
                      <td>
                        <div className="tok">
                          <div className="ph" style={{ width: 28, height: 28, fontSize: 11 }}>{p.symbol.slice(0, 2).toUpperCase()}</div>
                          <div className="meta">
                            <div className="sym">{p.symbol}</div>
                            <div className="nm" style={{ fontSize: 11 }}>Avg: ${p.avgBuyPrice.toFixed(4)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num">${p.currentPrice.toFixed(4)}</td>
                      <td className="num">
                        <span className={`badge ${isUp ? 'up' : 'down'}`}>
                          {isUp ? '▲ +' : '▼ '}{p.pnlPct.toFixed(2)}%
                        </span>
                      </td>
                      <td>
                        {/* Progress to target answers "how far to go?" — the raw
                            TP/SL prices alone made the reader do the arithmetic.
                            The bar spans SL→TP with the live price marked. */}
                        <TargetBar p={p} />
                        {p.status === 'TRAILING_ACTIVE' && (
                          <div style={{ marginTop: 3 }}>
                            <span className="chip" style={{ fontSize: 9.5, padding: '1px 6px', background: 'rgba(122, 158, 143, .14)', color: 'var(--accent2)', border: '1px solid rgba(122, 158, 143, .4)' }}>
                              <IconLock size={12} /> Trailing {p.highestPrice ? `· peak $${p.highestPrice.toFixed(4)}` : ''}
                            </span>
                          </div>
                        )}
                        {p.status === 'MOONBAG_RUNNER' && (
                          <div style={{ marginTop: 3 }}>
                            <span className="chip" style={{ fontSize: 9.5, padding: '1px 6px', background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid rgba(232, 163, 61, .4)' }}>
                              <IconRocket size={12} /> Moonbag 50%
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!ap.guardedPositions?.length && (
            <div className="empty" style={{ padding: 28 }}>
              <IconShield size={32} />
              Tidak ada posisi aktif di portfolio. Auto-Pilot akan otomatis melindungi token setelah order BUY dieksekusi.
            </div>
          )}
        </div>

        {/* Terminal activity feed — the one place a real terminal is the right
            metaphor, so it gets the full monospace treatment. */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-2)' }}>
          <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--up)', fontSize: 10, lineHeight: 1 }}>●</span>
              <strong style={{ fontSize: 11, fontFamily: 'var(--font-heading)', color: 'var(--muted)', letterSpacing: '.14em' }}>
                TERMINAL ACTIVITY FEED
              </strong>
              <span style={{ color: 'var(--dim)', fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>{visibleLogs.length} log</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              {logTags.map((t) => (
                <button
                  key={t}
                  onClick={() => setTagFilter(t)}
                  aria-pressed={tagFilter === t}
                  style={{
                    background: tagFilter === t ? 'var(--accent-dim)' : 'transparent',
                    color: tagFilter === t ? 'var(--accent)' : 'var(--dim)',
                    border: tagFilter === t ? '1px solid var(--accent)' : '1px solid transparent',
                    borderRadius: 2,
                    fontSize: 9.5,
                    padding: '2px 6px',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    letterSpacing: '.04em',
                  }}
                >
                  {t}
                </button>
              ))}
              <button
                onClick={handleClearLogs}
                style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 10.5, textDecoration: 'underline', marginLeft: 6, fontFamily: 'var(--font-body)' }}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Search across message + structured details. */}
          <div style={{ padding: '9px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="search"
              placeholder="cari simbol, intent id, atau teks…"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              style={{ minHeight: 32, padding: '6px 10px', fontSize: 12 }}
              aria-label="Cari log"
            />
            {logSearch && (
              <button
                onClick={() => setLogSearch('')}
                style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}
              >
                Reset
              </button>
            )}
          </div>

          <div
            ref={logScrollRef}
            onScroll={handleLogScroll}
            style={{ padding: 13, flex: 1, maxHeight: 268, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65 }}
          >
            {visibleLogs.map((l, i) => {
              const tagColor =
                l.tag === 'BUY' || l.tag === 'TP'
                  ? 'var(--up)'
                  : l.tag === 'SELL' || l.tag === 'SL'
                  ? 'var(--down)'
                  : l.tag === 'WARN'
                  ? 'var(--accent)'
                  : l.tag === 'ROTATE'
                  ? 'var(--accent2)'
                  : 'var(--muted)';

              return (
                <div key={l.id} style={{ marginBottom: 5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--dim)', flexShrink: 0 }}>
                    {new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span
                    style={{
                      color: tagColor,
                      borderLeft: `2px solid ${tagColor}`,
                      paddingLeft: 5,
                      fontWeight: 600,
                      fontSize: 9.5,
                      flexShrink: 0,
                      letterSpacing: '.05em',
                      minWidth: 44,
                    }}
                  >
                    {l.tag}
                  </span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word', opacity: .92, flex: 1 }}>{l.msg}</span>
                  <LogDetails details={l.details} />
                  {/* Only the newest line is highlighted; older ones stay flat so
                      the eye tracks the live edge instead of a wall of amber. */}
                  {i === visibleLogs.length - 1 && followLogs && (
                    <span style={{ color: 'var(--accent)', flexShrink: 0, fontSize: 9 }}>▍</span>
                  )}
                </div>
              );
            })}
            {!visibleLogs.length && (
              <div style={{ color: 'var(--dim)', textAlign: 'center', padding: '30px 0' }}>
                {logSearch
                  ? `[No match] "${logSearch}"`
                  : tagFilter !== 'ALL'
                    ? `[No ${tagFilter} logs]`
                    : '[Terminal Ready] Menunggu sinyal Auto-Pilot...'}
              </div>
            )}
            <div ref={logsEndRef} />
          </div>

          {/* Resumes following the tail after the reader scrolled away. */}
          {!followLogs && unseenLogs > 0 && (
            <div style={{ padding: '6px 16px', borderTop: '1px solid var(--rule)', textAlign: 'right' }}>
              <button
                onClick={() => {
                  setFollowLogs(true);
                  setUnseenLogs(0);
                }}
                className="btn"
                style={{ minHeight: 26, padding: '2px 10px', fontSize: 11, fontFamily: 'var(--font-mono)' }}
              >
                ↓ {unseenLogs} baru — kembali ke live
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Equity / PnL performance chart */}
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}><IconChartLine size={16} /> Equity Curve (Auto-Pilot PnL)</strong>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{ap.pnlHistory?.length ?? 0} titik · refresh 2s</span>
        </div>
        <EquityChart points={ap.pnlHistory ?? []} />
      </div>

      {/* Execution surface: the autopilot proposes, the user approves. This
          strip is read-only — signing happens in MetaMask, never here. */}
      <div className="card" style={{ padding: 14, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
        <IconKey size={14} />
        <strong style={{ fontSize: 13 }}>Eksekusi</strong>
        <span
          className="chip"
          style={{
            background: !connected ? 'var(--panel-2)' : !isBound ? 'rgba(245,158,11,.16)' : 'var(--up-bg)',
            color: !connected ? 'var(--muted)' : !isBound ? 'var(--accent)' : 'var(--up)',
            fontSize: 10, fontWeight: 700,
          }}
        >
          {!connected ? 'BELUM CONNECT' : !isBound ? 'BELUM BIND' : 'APPROVE DI METAMASK'}
        </span>
        {isBound && boundWallet && (
          <span style={{ color: 'var(--muted)' }}>
            {shortAddr(boundWallet, 4)}
            {openIntents.length > 0 && ` · ${openIntents.length} intent menunggu approve`}
          </span>
        )}
        <span style={{ color: 'var(--muted)' }}>Kelola di halaman</span>
        <button type="button" className="btn" style={{ minHeight: 28, padding: '2px 10px', fontSize: 12 }} onClick={() => onNavigate?.('settings')}>
          Pengaturan
        </button>
      </div>

      {/* Radar → trade form (real mode): the user picks the token in the form
          itself; the radar row only opens the dialog. */}
      {radarTrade && (
        <Modal title={`Trade ${radarTrade.token.symbol} (Dana Asli)`} onClose={() => setRadarTrade(null)} maxWidth={560}>
          <RealTradeForm />
        </Modal>
      )}

      {/* Top AI Signals Market Scanner */}
      <div className="card">
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>Market AI Radar (Top Scanned Tokens)</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {autopilot?.enabled ? 'Live Refresh 5s' : 'Auto-Pilot OFF — radar berhenti (tidak ada token LLM terpakai)'}
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">Harga Live</th>
                <th>Sinyal AI</th>
                <th className="num">Confidence</th>
                <th className="num">Target TP</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {(scannedSignals ?? []).map((s) => (
                <tr key={s.token.address}>
                  <td>
                    <div className="tok">
                      <div className="ph">{s.token.symbol.slice(0, 2).toUpperCase()}</div>
                      <div className="meta">
                        <div className="sym">{s.token.symbol}</div>
                        <div className="nm">{s.token.chainId}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num">${s.token.priceUsd.toFixed(6)}</td>
                  <td>
                    <span className={`badge ${s.verdict.signal.includes('BUY') ? 'up' : s.verdict.signal === 'SELL' ? 'down' : 'flat'}`}>
                      {s.verdict.signal.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="num" style={{ fontFamily: 'var(--font-heading)' }}>{s.verdict.confidence}%</td>
                  <td className="num">${s.verdict.targetPrice.toFixed(6)}</td>
                  <td>
                  <button className="btn icon" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => handleAnalyze(s.token.address)}>
                    Audit
                  </button>
                </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!scannedSignals?.length && <div className="empty">Sedang memindai sinyal AI pasar realtime…</div>}
      </div>

      {/* Signal History + Accuracy */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <strong style={{ fontSize: 14 }}>Signal History & Akurasi</strong>
          {ap.signalAccuracy && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Akurasi 1h: <b style={{ color: (ap.signalAccuracy.acc1h ?? 0) >= 50 ? 'var(--up)' : 'var(--down)' }}>{ap.signalAccuracy.acc1h === null ? '—' : `${ap.signalAccuracy.acc1h}%`}</b>
              {' · '}24h: <b style={{ color: (ap.signalAccuracy.acc24h ?? 0) >= 50 ? 'var(--up)' : 'var(--down)' }}>{ap.signalAccuracy.acc24h === null ? '—' : `${ap.signalAccuracy.acc24h}%`}</b>
              {' · '}sinyal: {ap.signalHistory?.length ?? 0}
            </span>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Waktu</th><th>Token</th><th>Sinyal</th><th className="num">Conf</th>
                <th className="num">Entry</th><th className="num">+1h</th><th className="num">+24h</th>
              </tr>
            </thead>
            <tbody>
              {(ap.signalHistory ?? []).slice(0, 30).map((s, i) => {
                const pct1 = s.price1h !== undefined && s.entryPrice > 0 ? ((s.price1h - s.entryPrice) / s.entryPrice) * 100 : null;
                const pct24 = s.price24h !== undefined && s.entryPrice > 0 ? ((s.price24h - s.entryPrice) / s.entryPrice) * 100 : null;
                return (
                  <tr key={`${s.address}:${s.ts}:${i}`}>
                    <td>{new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td><strong>{s.symbol}</strong></td>
                    <td>
                      <span className={`badge ${s.signal.includes('BUY') ? 'up' : s.signal === 'SELL' ? 'down' : 'flat'}`}>{s.signal.replace('_', ' ')}</span>
                    </td>
                    <td className="num">{s.confidence}%</td>
                    <td className="num">${s.entryPrice.toFixed(8)}</td>
                    <td className="num">
                      {pct1 === null ? '…' : <span className={`badge ${pct1 >= 0 ? 'up' : 'down'}`}>{pct1 >= 0 ? '+' : ''}{pct1.toFixed(1)}%</span>}
                    </td>
                    <td className="num">
                      {pct24 === null ? '…' : <span className={`badge ${pct24 >= 0 ? 'up' : 'down'}`}>{pct24 >= 0 ? '+' : ''}{pct24.toFixed(1)}%</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!(ap.signalHistory?.length) && (
          <div className="empty" style={{ padding: 24 }}>Belum ada sinyal dicatat — nyalakan Auto-Pilot atau jalankan scan untuk mulai merekam.</div>
        )}
      </div>

      {/* Memory Inspector — agents' decision log & near-misses */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <strong style={{ fontSize: 14 }}>🧠 Memory Inspector</strong>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Keputusan: {ap.memory?.length ?? 0} · Near-misses: {ap.nearMisses?.length ?? 0}
          </span>
        </div>

        {/* Calibration strip from signalAccuracy */}
        {ap.signalAccuracy && (ap.signalAccuracy.acc1h !== null || ap.signalAccuracy.acc24h !== null) && (
          <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <strong>Kalibrasi sinyal (1h):</strong> {ap.signalAccuracy.acc1h !== null ? `${ap.signalAccuracy.acc1h}% (${ap.signalAccuracy.win1h}/${ap.signalAccuracy.n1h})` : '—'}
            {' | '}
            <strong>24h:</strong> {ap.signalAccuracy.acc24h !== null ? `${ap.signalAccuracy.acc24h}% (${ap.signalAccuracy.win24h}/${ap.signalAccuracy.n24h})` : '—'}
            {ap.signalAccuracy.bySignal && Object.keys(ap.signalAccuracy.bySignal).length > 0 && (
              <span style={{ marginLeft: 10 }}>
                Per sinyal: {Object.entries(ap.signalAccuracy.bySignal).map(([k, v]) => `${k.replace('_', ' ')} ${Math.round((v.win1h / v.n1h) * 100)}% (n=${v.n1h})`).join('; ')}
              </span>
            )}
          </div>
        )}

        {/* Decisions table */}
        {ap.memory && ap.memory.length > 0 && (
          <>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>
              Keputusan tertutup (terbaru dulu)
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Waktu</th>
                    <th>Token</th>
                    <th>Sinyal</th>
                    <th className="num">Entry</th>
                    <th className="num">Outcome</th>
                    <th>Regime</th>
                    <th>Exit</th>
                    <th className="num">Hold</th>
                  </tr>
                </thead>
                <tbody>
                  {ap.memory.slice(0, 20).map((m, i) => (
                    <tr key={`${m.ts}:${i}`}>
                      <td>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                      <td><strong>{m.symbol}</strong></td>
                      <td><span className={`badge ${m.signal.includes('BUY') ? 'up' : m.signal === 'SELL' ? 'down' : 'flat'}`}>{m.signal.replace('_', ' ')}</span></td>
                      <td className="num">${m.entryPrice.toFixed(6)}</td>
                      <td className="num"><span className={`badge ${m.outcomePct >= 0 ? 'up' : 'down'}`}>{m.outcomePct >= 0 ? '+' : ''}{m.outcomePct.toFixed(1)}%</span></td>
                      <td><span className="chip" style={{ fontSize: 10 }}>{m.regime ?? '—'}</span></td>
                      <td><span className="chip" style={{ fontSize: 10 }}>{m.exitReason ?? '—'}</span></td>
                      <td className="num">{m.holdMs ? `${Math.round(m.holdMs / 3_600_000)}h` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Near-misses table */}
        {ap.nearMisses && ap.nearMisses.length > 0 && (
          <>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>
              Near-misses (sinyal kuat tapi tak dieksekusi)
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Waktu</th>
                    <th>Token</th>
                    <th>Sinyal</th>
                    <th className="num">Conf</th>
                    <th className="num">Entry</th>
                    <th>Alasan Skip</th>
                  </tr>
                </thead>
                <tbody>
                  {ap.nearMisses.slice(0, 20).map((m, i) => (
                    <tr key={`${m.ts}:${i}`}>
                      <td>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                      <td><strong>{m.symbol}</strong></td>
                      <td><span className={`badge ${m.signal.includes('BUY') ? 'up' : m.signal === 'SELL' ? 'down' : 'flat'}`}>{m.signal.replace('_', ' ')}</span></td>
                      <td className="num">{m.confidence}%</td>
                      <td className="num">${m.entryPrice.toFixed(6)}</td>
                      <td><span className="chip" style={{ fontSize: 10 }}>{m.reason}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!ap.memory?.length && !ap.nearMisses?.length && (
          <div className="empty" style={{ padding: 24 }}>Belum ada memori — nyalakan Auto-Pilot dan biarkan melindungi / mencari posisi.</div>
        )}
      </div>

      {/* Interactive Token Audit Bar */}
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase' }}>
          Audit Manual Multi-Agent (Debate Desk)
        </div>
        <div className="row">
          <input
            className="input"
            style={{ flex: 1, minWidth: 260 }}
            placeholder="Address atau ticker token (misal: SOL, PEPE, BONK)…"
            value={tokenAddr}
            onChange={(e) => setTokenAddr(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAnalyze(tokenAddr)}
          />
          <button className="btn primary" onClick={() => handleAnalyze(tokenAddr)} disabled={analyzing || !tokenAddr.trim()}>
            {analyzing ? 'Agents Berdebat…' : <><IconBot size={14} /> Jalankan AI Debate</>}
          </button>
        </div>

        {/* Quick select chips */}
        {watchlist && watchlist.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>Dari Watchlist:</span>
            {watchlist.map((w) => (
              <button
                key={w.tokenAddress}
                type="button"
                className="chip"
                style={{ border: 'none', cursor: 'pointer' }}
                onClick={() => { setTokenAddr(w.tokenAddress); handleAnalyze(w.tokenAddress); }}
              >
                {w.symbol ?? 'Token'}
              </button>
            ))}
          </div>
        )}

        {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
        {tradeSuccess && (
          <div style={{ background: 'var(--up-bg)', color: 'var(--up)', padding: 12, borderRadius: 8, fontSize: 13, marginTop: 12 }}>
            ✓ {tradeSuccess}
          </div>
        )}
      </div>

      {/* Multi-Agent Debate Arena Result */}
      {report && (
        <div style={{ marginBottom: 28 }}>
          <div className="card" style={{ padding: 20, marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="ph" style={{ width: 38, height: 38, fontSize: 14 }}>{report.token.symbol.slice(0, 2).toUpperCase()}</div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 18, fontFamily: 'var(--font-heading)' }}>{report.token.symbol} ({report.token.chainId})</strong>
                  {report.llmPowered && (
                    <span className="chip" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10.5 }}>
                      <IconSparkles size={12} /> LLM: {report.llmProvider}
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>Live Price: ${report.token.priceUsd.toFixed(6)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' }}>Sinyal Final</div>
                <span className={`badge ${report.verdict.signal.includes('BUY') ? 'up' : report.verdict.signal === 'SELL' ? 'down' : 'flat'}`} style={{ fontSize: 14, padding: '6px 14px' }}>
                  {report.verdict.signal.replace('_', ' ')} ({report.verdict.confidence}%)
                </span>
              </div>

              {report.verdict.signal !== 'HOLD' && (
                <button
                  className="btn"
                  onClick={handleExecuteAIOrder}
                  disabled={executingTrade}
                  style={{
                    background: report.verdict.signal.includes('BUY') ? 'var(--up)' : 'var(--down)',
                    color: report.verdict.signal.includes('BUY') ? '#000' : '#fff',
                    fontWeight: 700,
                  }}
                >
                  {executingTrade ? 'Mengeksekusi…' : `Eksekusi ${report.verdict.signal.includes('BUY') ? 'BUY' : 'SELL'} ($${report.verdict.recommendedUsd})`}
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 18 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 14 }}><IconChartBar size={16} /> Technical Analyst</strong>
                <span className="chip">{report.agents.technical.trend}</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                {report.agents.technical.findings.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>

            <div className="card" style={{ padding: 18, borderLeft: '3px solid var(--up)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 14, color: 'var(--up)' }}><IconTrendingUp size={16} /> Bull Researcher</strong>
                <span className="badge up">Score: {report.agents.bull.score}%</span>
              </div>
              {report.agents.bull.divergent && (
                <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 8 }}>
                  ⚠ Divergen: LLM {report.agents.bull.llmScore}% vs Quant {report.agents.bull.detScore}% — dipakai rata-rata
                </div>
              )}
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                {report.agents.bull.thesis.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>

            <div className="card" style={{ padding: 18, borderLeft: '3px solid var(--down)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 14, color: 'var(--down)' }}><IconTrendingDown size={16} /> Bear Researcher</strong>
                <span className="badge down">Risk: {report.agents.bear.score}%</span>
              </div>
              {report.agents.bear.divergent && (
                <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 8 }}>
                  ⚠ Divergen: LLM {report.agents.bear.llmScore}% vs Quant {report.agents.bear.detScore}% — dipakai rata-rata
                </div>
              )}
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                {report.agents.bear.risks.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 14 }}><IconShield size={16} /> Risk Manager</strong>
                <span className={`chip ${report.agents.risk.approved ? 'up' : 'down'}`}>
                  {report.agents.risk.approved ? 'APPROVED' : 'REJECTED'}
                </span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                • Max Alokasi: <strong>${report.agents.risk.maxUsdPosition} USDC</strong> ({report.agents.risk.maxAllocationPct}%)<br />
                • Target Take Profit: <strong>${report.agents.risk.takeProfitPrice.toFixed(6)}</strong> (+{report.agents.risk.targetProfitPct}%)<br />
                • Stop Loss: <strong>${report.agents.risk.stopLossPrice.toFixed(6)}</strong> (-{report.agents.risk.stopLossPct}%)<br />
                {report.agents.risk.rejectionReason && <span style={{ color: 'var(--down)' }}>• Alasan: {report.agents.risk.rejectionReason}</span>}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 16, background: 'var(--panel-2)', fontSize: 13 }}>
            <strong>Trader Synthesis:</strong> {report.verdict.summary}
          </div>
        </div>
      )}

    </>
  );
}

/**
 * Structured fields the backend already sends on a log entry, rendered as a
 * compact key:value tail. Before this, `details` was received and thrown away,
 * so a PnL or fill price only existed inside the prose message — unreadable
 * once the message got long, and impossible to search.
 *
 * Only a small allowlist is shown: dumping the raw object would bury the
 * message under bookkeeping the reader does not act on.
 */
const DETAIL_KEYS = [
  'pnlUsd', 'filledTokens', 'realPrice', 'estimatedPrice',
  'balanceNative', 'buyUsd', 'usdAmount', 'cappedUsd',
  'signature', 'intentId', 'symbol', 'reason',
];

function LogDetails({ details }: { details?: Record<string, unknown> }) {
  if (!details) return null;
  const parts: string[] = [];
  for (const key of DETAIL_KEYS) {
    const v = details[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') continue;
    let shown: string;
    if (key === 'pnlUsd' || key === 'realPrice' || key === 'estimatedPrice') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const sign = key === 'pnlUsd' && n >= 0 ? '+' : '';
      const abs = Math.abs(n);
      // Memecoin prices routinely sit below 1e-6, where toFixed(6) renders a
      // flat "0.000000" and destroys the value. Step down in precision instead.
      const digits = abs === 0 ? 2 : abs >= 1 ? 2 : abs >= 0.0001 ? 6 : 9;
      shown = `${sign}$${n.toFixed(digits)}`;
    } else if (key === 'signature' || key === 'intentId') {
      // Truncate hashes/ids — the full value is never read at a glance and
      // would push the row into a second line.
      shown = String(v).slice(0, 10) + '…';
    } else if (key === 'balanceNative' || key === 'filledTokens') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const abs = Math.abs(n);
      shown = n.toFixed(abs >= 1 ? 4 : abs >= 0.0001 ? 6 : 9);
    } else if (key === 'usdAmount' || key === 'buyUsd' || key === 'cappedUsd') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      shown = `$${n.toFixed(2)}`;
    } else {
      shown = String(v).slice(0, 24);
    }
    parts.push(`${key}=${shown}`);
    if (parts.length >= 3) break;
  }
  if (parts.length === 0) return null;
  return (
    <span
      style={{
        color: 'var(--dim)',
        fontSize: 10,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        letterSpacing: '.02em',
      }}
      title={JSON.stringify(details)}
    >
      {parts.join(' · ')}
    </span>
  );
}

/**
 * A guarded position's distance to its exit levels, drawn as a rule spanning
 * SL → TP with a marker at the live price. Replaces two bare price labels that
 * left the reader doing the arithmetic themselves.
 */
function TargetBar({ p }: { p: AutopilotGuardedPosition }) {
  const { slPrice, tpPrice, currentPrice, avgBuyPrice } = p;
  // A degenerate band (SL above TP, or a flat target) would divide by ~0 and
  // throw the marker off-screen. Fall back to a plain price readout instead.
  const band = tpPrice - slPrice;
  if (!Number.isFinite(band) || band <= 0) {
    return <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>${currentPrice.toFixed(4)}</span>;
  }
  const pos = Math.min(100, Math.max(0, ((currentPrice - slPrice) / band) * 100));
  // How much of the SL→TP move is already banked, measured from the entry.
  const progress = Math.min(100, Math.max(0, ((currentPrice - avgBuyPrice) / band) * 100));

  return (
    <div style={{ minWidth: 132 }}>
      <div style={{ position: 'relative', height: 5, background: 'var(--bg)', border: '1px solid var(--rule)' }}>
        <div style={{ position: 'absolute', inset: 'auto 0 0 0', height: '100%', width: `${pos}%`, background: currentPrice >= avgBuyPrice ? 'var(--up-bg)' : 'var(--down-bg)' }} />
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${pos}%`, width: 1, background: 'var(--text)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--dim)', marginTop: 3 }}>
        <span>SL ${slPrice.toFixed(4)}</span>
        <span style={{ color: 'var(--muted)' }}>{progress.toFixed(0)}% ke TP</span>
        <span>TP {tpPrice.toFixed(4)}</span>
      </div>
    </div>
  );
}
