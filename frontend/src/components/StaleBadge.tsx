// Amber stale-data badge shown in page heads when polling fails — makes the
// earlier "freeze / high latency" reports diagnosable: amber dot = backend slow,
// not a frozen page. Importers/callers: page heads (Overview, Portfolio, Agents,
// Trending, Watchlist). API: `<StaleBadge stale />`. Presentational, no schema.
// User instruction: "improve user experience:ALL".
export function StaleBadge({ stale }: { stale?: boolean }) {
  return (
    <span
      className={`stale-badge${stale ? ' stale' : ''}`}
      title={stale ? 'Backend lambat — data terakhir tidak diperbarui' : 'Data live'}
    >
      <span className="stale-dot" />
      {stale ? '⚠ data stale' : 'LIVE'}
    </span>
  );
}