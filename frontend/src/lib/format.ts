export const fmt = {
  usd: (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%',
};