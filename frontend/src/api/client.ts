// API client + shared types for the trading dashboard & multi-agent trading system.
// `ponytail:` no runtime validation — backend is our own proxy, types mirror it.

export interface Market {
  pairAddress: string;
  chainId: string;
  dexId: string;
  url: string;
  symbol: string | null;
  name: string | null;
  tokenAddress: string;
  icon: string | null;
  priceUsd: number;
  priceNative?: string;
  change24h: number;
  change5m: number;
  change1h: number;
  volume24h: number;
  liquidityUsd: number;
  fdv: number;
  txns24h: { buys: number; sells: number };
}

export interface TrendingProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon: string | null;
  description: string | null;
  links?: { type?: string | null; label?: string | null; url: string }[];
  symbol: string | null;
  name: string | null;
  market: Market | null;
}

export interface WatchEntry {
  tokenAddress: string;
  chainId: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  addedAt: number;
  market: Market | null;
}

export interface Overview {
  watchedTokens: number;
  chainsActive: number;
  totalVolume24h: number;
  totalLiquidityUsd?: number;
  topGainer: Market | null;
  topLoser: Market | null;
  markets: Market[];
  watchlistMarkets?: Market[];
  walletSnapshot?: {
    balance: number;
    totalValue: number;
    openPositionsCount: number;
  };
}

export interface Position {
  tokenAddress: string;
  symbol: string;
  name?: string;
  chainId: string;
  amount: number;
  avgBuyPrice: number;
  totalCost: number;
  currentPrice?: number;
  highestPrice?: number;
  realizedPnl?: number;
  tp1Hit?: boolean;
}

export interface Wallet {
  balance: number;
  available: number;
  initialBalance: number;
  totalValue: number;
  totalPositionValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  reservedUsd: number;
}

export interface Order {
  id: string;
  type: 'market' | 'limit';
  side: 'buy' | 'sell';
  tokenAddress: string;
  chainId: string;
  symbol: string;
  name?: string;
  amount: number;
  price: number;
  targetPrice?: number;
  usdAmount: number;
  status: 'filled' | 'open' | 'cancelled';
  createdAt: number;
  filledAt: number | null;
}

// Multi-Agent Engine Types
export interface AgentTechnical {
  trend: string;
  momentumScore: number;
  buyRatio: number;
  buys: number;
  sells: number;
  volToLiqRatio: number;
  liquidityUsd: number;
  volume24h: number;
  priceUsd: number;
  findings: string[];
}

export interface AgentBull {
  score: number;
  thesis: string[];
  quote: string;
  llmScore?: number;
  detScore?: number;
  divergent?: boolean;
}

export interface AgentBear {
  score: number;
  risks: string[];
  quote: string;
  llmScore?: number;
  detScore?: number;
  divergent?: boolean;
}

export interface AgentRisk {
  approved: boolean;
  rejectionReason: string | null;
  maxAllocationPct: number;
  maxUsdPosition: number;
  stopLossPct: number;
  targetProfitPct: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

export interface AgentVerdict {
  signal: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL';
  confidence: number;
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  recommendedUsd: number;
  recommendedTokens: number;
  summary: string;
}

export interface LLMConfig {
  provider: '9router' | 'anthropic' | 'openai' | 'deepseek' | 'openrouter' | 'custom';
  providers?: string[];
  models?: string[];
  model: string;
  baseUrl?: string;
  hasKey: boolean;
  maskedKey: string;
  /** Full stack (keys masked) so the modal can edit every entry. */
  entries?: LLMEntryInfo[];
}

/** One stack entry as returned by GET /api/llm/config (no raw key). */
export interface LLMEntryInfo {
  provider: '9router' | 'anthropic' | 'openai' | 'deepseek' | 'openrouter' | 'custom' | string;
  model: string;
  baseUrl: string;
  role: string | null;
  hasKey: boolean;
  maskedKey: string;
}

/** One entry of the multi-LLM provider stack. */
export interface LLMProviderEntry {
  provider: '9router' | 'anthropic' | 'openai' | 'deepseek' | 'openrouter' | 'custom';
  apiKey?: string;
  model: string;
  baseUrl?: string;
  role?: 'bull' | 'bear' | 'lead' | null;
}

export interface AgentReport {
  timestamp: number;
  llmPowered?: boolean;
  llmProvider?: string;
  token: {
    address: string;
    symbol: string;
    name?: string;
    chainId: string;
    dexId: string;
    priceUsd: number;
    icon?: string;
  };
  agents: {
    technical: AgentTechnical;
    bull: AgentBull;
    bear: AgentBear;
    risk: AgentRisk;
  };
  verdict: AgentVerdict;
}

export interface AutopilotGuardedPosition {
  symbol: string;
  address: string;
  chainId: string;
  amount: number;
  avgBuyPrice: number;
  currentPrice: number;
  highestPrice?: number;
  tp1Hit?: boolean;
  pnlUsd: number;
  pnlPct: number;
  tpPrice: number;
  slPrice: number;
  status: 'GUARDED' | 'TP_TRIGGER' | 'SL_TRIGGER' | 'TRAILING_ACTIVE' | 'MOONBAG_RUNNER';
}

export interface AutopilotLog {
  id: string;
  ts: number;
  tag: 'BUY' | 'SELL' | 'TP' | 'SL' | 'GUARD' | 'SCAN' | 'WARN' | 'CONFIG' | 'ROTATE';
  msg: string;
  details?: Record<string, unknown>;
}

export interface AutopilotStats {
  totalScans: number;
  /** Completed round trips (PnL is only known at the exit). */
  totalTrades: number;
  profitableTrades: number;
  totalProfitUsd: number;
  winRate: number;
}

export interface SignalHistoryEntry {
  ts: number;
  symbol: string;
  address: string;
  signal: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL';
  confidence: number;
  entryPrice: number;
  bull: { score: number; thesis: string[] };
  bear: { score: number; risks: string[] };
  llmPowered: boolean;
  price1h?: number;
  price24h?: number;
}

export interface RealIntent {
  id: string;
  symbol: string;
  tokenAddress: string;
  chainId: string;
  side: 'buy' | 'sell';
  source: string; // 'STRONG_BUY' | 'BUY' | 'SL' | 'TP' | 'TRAILING' | 'ROTATE' | 'WARN'
  amountUsd: number;
  estTokens: number;
  intentPrice: number;
  status: 'open' | 'active' | 'done' | 'cancelled';
  createdAt: number;
  resolvedAt?: number;
  /** Agent/LLM provenance so the UI can show WHY a trade is proposed. */
  confidence?: number;
  llmPowered?: boolean;
  bullScore?: number | null;
  bearScore?: number | null;
}

/** Unsigned swap tx built by the backend for MetaMask to sign. */
export interface BuiltSwapTx {
  chain: string;
  chainId: number;
  /** Must be the allow-listed 1inch router — the client re-checks this. */
  to: string;
  data: string;
  value: string;
  gas: string | null;
  /** True when `src` is an ERC-20 and an allowance must be granted first. */
  needsApproval: boolean;
  approveSpender: string | null;
  /** Exact atomic amount to approve — never an unlimited grant. */
  approveAmount: string | null;
  slippageBps: number;
  intentId?: string;
}

export interface SignalAccuracy {
  total: number;
  win1h: number;
  n1h: number;
  win24h: number;
  n24h: number;
  acc1h: number | null;
  acc24h: number | null;
  bySignal: Record<string, { n: number; win1h: number; n1h: number }>;
}

/** One closed-trade memory entry (agents learn from these). */
export interface MemoryEntry {
  ts: number;
  symbol: string;
  signal: string;
  confidence: number;
  entryPrice: number;
  outcomePct: number;
  regime?: string;
  chainId?: string;
  liquidityUsd?: number;
  volume24h?: number;
  fdv?: number;
  buyRatio?: number;
  volToLiqRatio?: number;
  exitReason?: string;
  holdMs?: number;
}

/** Strong signal the scout could not act on. */
export interface NearMissEntry {
  ts: number;
  symbol: string;
  address: string;
  chainId: string;
  signal: string;
  confidence: number;
  entryPrice: number;
  reason: string;
}

export interface AutopilotConfig {
  enabled: boolean;
  status: 'IDLE' | 'SCANNING' | 'GUARDIAN' | 'PAUSED';
  riskLevel: 'low' | 'medium' | 'high';
  minConfidence: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct?: number;
  trailingTriggerPct?: number;
  moonbagX?: number;
  maxOpenPositions: number;
  rotateAfterHours?: number;
  maxExposurePct?: number;
  agentMode?: 'blend' | 'deterministic' | 'llm';
  /** Per-provider LLM request timeout (5_000-180_000 ms). */
  llmTimeoutMs?: number;
  /** Parallel analyzeToken calls per scan (1-6). */
  scanConcurrency?: number;
  /** 3rd LLM call (Lead Trader) that writes the verdict prose. */
  enableLeadSynthesis?: boolean;
  lastScanAt: number | null;
  guardedPositionsCount: number;
  guardedPositions: AutopilotGuardedPosition[];
  stats: AutopilotStats;
  logs: AutopilotLog[];
  pnlHistory?: { ts: number; totalValue: number }[];
  signalHistory?: SignalHistoryEntry[];
  signalAccuracy?: SignalAccuracy;
  memory?: MemoryEntry[];
  nearMisses?: NearMissEntry[];
}

export type Page = 'overview' | 'trending' | 'watchlist' | 'chart' | 'trade' | 'portfolio' | 'agents' | 'leaderboard' | 'settings';

export interface HistoryPoint {
  priceUsd: number;
  ts: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('trading_token');
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    // Session expired/revoked — drop token, let App gate on it.
    localStorage.removeItem('trading_token');
    dispatchEvent(new Event('trading-unauthorized'));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) msg = parsed.error;
    } catch {}
    // Carry the HTTP status so callers can tell a PERMANENT failure (400 bad
    // request, 404 gone, 403 forbidden — retrying will never help) from a
    // TRANSIENT one (5xx, 429). Without this the intent auto-retry loop spins
    // on an unfixable error and floods the API until it rate-limits (429).
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface LoginResult {
  token: string;
  userId: string;
  username: string;
}

export const AUTH = {
  login: (username: string, password: string) =>
    req<LoginResult>('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  me: () => req<{ userId: string; username: string; wallet: Wallet }>('/api/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean }>('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

export interface LeaderboardRow {
  userId: string;
  username: string;
  totalValue: number;
  pnlPct: number;
  positionsCount: number;
}

/** Download a CSV export (carries the auth header, unlike a plain <a href>). */
export async function exportCsv(kind: 'orders' | 'positions'): Promise<void> {
  const token = localStorage.getItem('trading_token');
  const res = await fetch(`/api/export/${kind}.csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export gagal: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kind}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  trending: (limit = 30) => req<TrendingProfile[]>(`/api/trending?limit=${limit}`),
  search: (q: string) => req<Market[]>(`/api/search?q=${encodeURIComponent(q)}`),
  overview: () => req<Overview>('/api/overview'),
  watchlist: () => req<WatchEntry[]>('/api/watchlist'),
  addWatch: (entry: { tokenAddress: string; chainId: string; symbol?: string | null; name?: string | null; icon?: string | null }) =>
    req<{ key: string }>('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }),
  removeWatch: (key: string) => req<void>(`/api/watchlist/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  history: (chainId: string, tokenAddress: string) => req<HistoryPoint[]>(`/api/watchlist/${chainId}/${tokenAddress}/history`),

  // Virtual Trading API
  wallet: () => req<Wallet>('/api/wallet'),
  portfolio: () => req<{ wallet: Wallet; positions: Position[]; orders: Order[]; ordersTotal?: number; ordersHasMore?: boolean }>('/api/portfolio'),
  ordersPage: (limit = 100, offset = 0) => req<{ orders: Order[]; total: number; limit: number; offset: number; hasMore: boolean }>(`/api/orders/page?limit=${limit}&offset=${offset}`),
  resetWallet: (initialBalance?: number) =>
    req<Wallet>('/api/wallet/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initialBalance === undefined ? {} : { initialBalance }),
    }),
  orders: () => req<Order[]>('/api/orders'),
  positions: () => req<Position[]>('/api/positions'),
  marketOrder: (data: { side: 'buy' | 'sell'; tokenAddress: string; chainId: string; symbol: string; name?: string; usdAmount: number; tokenAmount: number }) =>
    req<Order>('/api/orders/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  limitOrder: (data: { side: 'buy' | 'sell'; tokenAddress: string; chainId: string; symbol: string; name?: string; targetPrice: number; usdAmount: number; tokenAmount: number }) =>
    req<Order>('/api/orders/limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  cancelOrder: (id: string) => req<Order>(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Real-wallet pending intents (autopilot → user approves via MetaMask)
  realIntents: () => req<RealIntent[]>('/api/real/intents'),
  realIntentStatus: (id: string, status: RealIntent['status'], claimToken?: string) =>
    req<RealIntent>(`/api/real/intents/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...(claimToken ? { claimToken } : {}) }),
    }),
  realMode: () => req<{ realMode: boolean }>('/api/real/mode'),
  setRealMode: (realMode: boolean) =>
    req<{ realMode: boolean }>('/api/real/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realMode }),
    }),

  // AI Multi-Agent API
  analyzeToken: (tokenAddress: string) =>
    req<AgentReport>('/api/agents/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenAddress }),
    }),
  agentSignals: (limit = 10) => req<AgentReport[]>(`/api/agents/signals?limit=${limit}`),
  getAutopilot: () => req<AutopilotConfig>('/api/agents/autopilot'),
  setAutopilot: (config: Partial<AutopilotConfig>) =>
    req<AutopilotConfig>('/api/agents/autopilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),
  clearAutopilotLogs: () => req<{ ok: boolean }>('/api/agents/autopilot/clear-logs', { method: 'POST' }),

  // LLM Provider Settings
  getLLMConfig: () => req<LLMConfig>('/api/llm/config'),
  setLLMConfig: (data: LLMProviderEntry | LLMProviderEntry[]) =>
    req<LLMConfig>('/api/llm/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  /** Model IDs from the provider's /models endpoint (9router combo box).
   *  POST so the API key travels in the body, never the URL. */
  llmModels: (params?: { provider?: string; baseUrl?: string; apiKey?: string }) =>
    req<{ models: string[] }>('/api/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    }),
  /** Probe a provider entry (models list → tiny chat fallback). */
  llmTest: (entry: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }) =>
    req<{ ok: boolean; via?: string; latencyMs: number; modelCount?: number; models?: string[]; sample?: string; error?: string; modelsError?: string }>(
      '/api/llm/test',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) },
    ),

  // Leaderboard
  leaderboard: () => req<LeaderboardRow[]>('/api/leaderboard'),

  // Real trading — EVM via 1inch. The server builds the UNSIGNED tx; MetaMask
  // signs it in the browser. No private key ever reaches the backend.
  realQuote: (data: { src: string; dst: string; amount: string; chain?: string }) =>
    req<{ inAmount?: string; outAmount?: string; priceImpactPct?: string; [k: string]: unknown }>(
      '/api/real/quote',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
    ),
  /** Unsigned swap tx for one intent. `to` must be the allow-listed 1inch router. */
  realSwapTx: (data: { intentId: string; from: string; chain?: string }) =>
    req<BuiltSwapTx>('/api/real/swap-tx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  /** A user's manual trade becomes a normal intent, so it inherits every guard. */
  manualIntent: (data: {
    tokenAddress: string; symbol?: string; side: 'buy' | 'sell';
    amountUsd: number; estTokens: number; intentPrice: number; chain?: string;
  }) => req<RealIntent>('/api/real/manual-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }),
  /** ERC-20 decimals resolved on-chain — required before sizing any sell. */
  realDecimals: (token: string, chain = 'base') =>
    req<{ token: string; chain: string; decimals: number }>(
      `/api/real/evm/decimals?token=${encodeURIComponent(token)}&chain=${encodeURIComponent(chain)}`,
    ),
  bindWallet: (data: { address: string; signature: string }) =>
    req<{ bound: boolean; address: string }>('/api/real/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  /** Server-issued single-use challenge the wallet signs to bind. */
  bindMessage: (address: string) =>
    req<{ message: string }>(`/api/real/bind-message?address=${encodeURIComponent(address)}`),
  boundWallet: () => req<{ boundWallet: string | null }>('/api/real/bound'),

  /** On-chain reads for the bound MetaMask address (read-only views). */
  realBalance: (chain = 'base') =>
    req<{ address: string; chain: string; native: number; nativeUsd: number | null }>(
      `/api/real/balance?chain=${encodeURIComponent(chain)}`,
    ),
  realPortfolio: (chain = 'base') =>
    req<{
      address: string; chain: string; native: number; nativeUsd: number | null;
      tokenValueUsd: number; totalUsd: number | null;
      holdings: { token: string; amount: number; decimals: number; priceUsd: number | null; valueUsd: number | null }[];
    }>(`/api/real/portfolio?chain=${encodeURIComponent(chain)}`),
};
