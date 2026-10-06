// View math for the real-wallet portfolio panel, kept pure and outside the
// component so the numbers the user acts on can be tested without a DOM.
// Importers/callers: components/RealWalletPortfolio.tsx; scripts/realWalletPortfolio.check.mts.
//
// The panel decides how much REAL money is on-chain. That number must never be
// quietly wrong: a gas coin with a balance but no price is "unknown", not zero,
// or the total understates the wallet and the user under-budgets a trade.

/** A single on-chain holding as GET /api/real/portfolio returns it. */
export interface Holding {
  token: string;
  /** Known symbol (e.g. USDT), or null when the backend does not recognise it. */
  symbol: string | null;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

/** Native coin below this cannot pay for an exit swap — the wallet is stuck. */
export const GAS_FLOOR = 0.005;

/** The portfolio panel tracks USDT only: the app's funding currency. */
export const DISPLAY_SYMBOL = 'USDT';

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** A usable price: finite and not negative. Zero is a legitimate (zero) price. */
const isPrice = (n: unknown): n is number => isNum(n) && n >= 0;

/**
 * Whether the panel actually knows the balances.
 *
 * `err` is load-bearing. A failed fetch leaves `loading` false with the initial
 * (empty) balances still in place, so a gate without this term flips true and
 * the panel tells a wallet that holds USDT that it holds none. Claiming zero
 * when we simply failed to look is the one thing this panel must never do.
 */
export function isReady({
  loading,
  err,
  isBound,
  chain,
  address,
}: {
  loading: boolean;
  err: string;
  isBound: boolean;
  chain: string | null;
  address: string | null;
}): boolean {
  return !loading && err === '' && isBound && chain !== null && address !== null;
}

/**
 * The USDT row, or null when the wallet holds none.
 *
 * Null means "0 USDT", not "unknown" — the backend omits zero balances, so an
 * absent row is a real zero. Symbol matching is case-insensitive because the
 * backend's symbol comes from its own known-token table.
 */
export function usdtRow(holdings: readonly Holding[]): Holding | null {
  const want = DISPLAY_SYMBOL.toLowerCase();
  return holdings.find((h) => h.symbol?.toLowerCase() === want) ?? null;
}

/**
 * The wallet's USDT amount, or null when it cannot be known.
 *
 * Null is a real state here, distinct from zero: the backend omits zero balances
 * AND silently drops non-zero holdings whose decimals it cannot read (counting
 * them in `unpricedCount`). One of those dropped holdings could have been the
 * USDT, so an absent USDT row alongside a non-zero `unpricedCount` means the
 * amount is unknown — printing "0 USDT" for a wallet that holds thousands is the
 * failure this guards.
 */
export function usdtAmount(holdings: readonly Holding[], unpricedCount = 0): number | null {
  const row = usdtRow(holdings);
  if (row) return row.amount;
  return unpricedCount > 0 ? null : 0;
}

/** A balance read, tagged with the chain + address it was fetched for. */
export interface BalanceSnapshot {
  chain: string;
  address: string;
  ok: boolean;
  native: number;
  usdt: number | null;
  err?: string;
}

/**
 * The snapshot that belongs to the live chain + address, or null.
 *
 * A read is only valid for the wallet it was fetched for. Clearing state in a
 * passive effect runs AFTER paint, so on a chain or account switch the previous
 * read would otherwise show for one committed frame under the new label. This is
 * a pure render-time gate: reject any snapshot whose tag does not match.
 */
export function currentSnapshot(
  loaded: BalanceSnapshot | null,
  chain: string,
  address: string,
): BalanceSnapshot | null {
  if (!loaded) return null;
  return loaded.chain === chain && loaded.address === address ? loaded : null;
}

/**
 * Total value of the wallet in USD, or null when it cannot be known.
 *
 * `nativeUsd` prices the gas coin. When the wallet HOLDS a gas coin the backend
 * could not price, the total is unknown rather than the tokens alone: the coin
 * is real money and dropping it silently is the failure this guards.
 *
 * `tokenValueUsd` is the backend's sum over every PRICED holding — it skips rows
 * whose `valueUsd` is null (evmWallet.js). So a wallet holding an unpriceable
 * token reports a token total that quietly omits it. `unpricedHoldings` is the
 * count of such rows the panel saw; when any exist the total is unknown, for the
 * same reason an unpriced gas coin is: the money is real, we just cannot value
 * it, and a partial sum under a "total" label is the failure this guards.
 */
export function onChainTotalUsd({
  native,
  nativeUsd,
  tokenValueUsd,
  unpricedHoldings = 0,
}: {
  native: number | null;
  nativeUsd: number | null;
  tokenValueUsd: number | null;
  unpricedHoldings?: number;
}): number | null {
  if (!isNum(native)) return null;
  if (unpricedHoldings > 0) return null; // a held token we cannot price
  let nativePart = 0;
  if (native > 0) {
    if (!isPrice(nativeUsd)) return null; // holds gas coin, cannot price it
    nativePart = native * nativeUsd;
  }
  const tokens = isPrice(tokenValueUsd) ? tokenValueUsd : 0;
  return Math.round((nativePart + tokens) * 100) / 100;
}

export type GasState = 'empty' | 'low' | 'ok' | 'unknown';

/**
 * Whether the wallet can pay for an exit swap.
 *
 * `unknown` is distinct from `empty`: an unread balance is a loading state, and
 * telling the user they have no gas when we simply have not looked is wrong.
 */
export function gasState(native: number | null): GasState {
  if (!isNum(native)) return 'unknown';
  if (native <= 0) return 'empty';
  return native < GAS_FLOOR ? 'low' : 'ok';
}
