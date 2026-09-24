// Number formatters. Both tolerate null/undefined/NaN: DexScreener returns
// priceUsd:null for delisted or no-trade tokens, and an unguarded
// `.toLocaleString()` on that throws mid-render — white-screening the page
// (App.tsx has no error boundary). Return a placeholder instead.
export const fmt = {
  usd: (n: number | null | undefined) =>
    Number.isFinite(n) ? '$' + (n as number).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—',
  pct: (n: number | null | undefined) =>
    Number.isFinite(n) ? ((n as number) >= 0 ? '+' : '') + (n as number).toFixed(2) + '%' : '—',
};