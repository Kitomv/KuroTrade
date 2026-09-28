// Equity curve — an SVG trace on a ruled chart, matching the terminal's
// hairline aesthetic. Colours come from CSS vars so the palette lives in one
// place (styles.css); hardcoded hex here would silently drift from it.
import { IconChartLine } from './Icons';
import { fmt } from '../lib/format';

interface Point {
  ts: number;
  totalValue: number;
}

export function EquityChart({ points }: { points: Point[] }) {
  const w = 720;
  const h = 200;
  const pad = { l: 62, r: 16, t: 22, b: 24 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  if (points.length < 2) {
    return (
      <div className="empty" style={{ padding: 28, fontSize: 13 }}>
        <IconChartLine size={24} />
        Belum ada data equity. Nyalakan Auto-Pilot untuk mulai merekam.
      </div>
    );
  }

  const vals = points.map((p) => p.totalValue);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const last = points[points.length - 1].totalValue;
  const first = points[0].totalValue;
  const up = last >= first;
  const color = up ? 'var(--up)' : 'var(--down)';

  const pts = points.map((p, i) => {
    const x = pad.l + (i / (points.length - 1)) * pw;
    const y = pad.t + ph - ((p.totalValue - min) / range) * ph;
    return [x, y] as const;
  });

  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${(pad.t + ph).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.t + ph).toFixed(1)} Z`;

  const midVal = (max + min) / 2;
  const MONO = 'var(--font-mono)';

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', width: '100%', height: 'auto', background: 'var(--bg-2)', borderRadius: 2 }}>
      <defs>
        <linearGradient id="eqUp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--up)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--up)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="eqDown" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--down)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--down)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Dashed reference rules, then a solid baseline. A printed chart, not a grid. */}
      <line x1={pad.l} y1={pad.t} x2={pad.l + pw} y2={pad.t} stroke="var(--rule)" strokeDasharray="2 4" />
      <line x1={pad.l} y1={pad.t + ph / 2} x2={pad.l + pw} y2={pad.t + ph / 2} stroke="var(--rule)" strokeDasharray="2 4" />
      <line x1={pad.l} y1={pad.t + ph} x2={pad.l + pw} y2={pad.t + ph} stroke="var(--border)" />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ph} stroke="var(--border)" />

      <path d={areaPath} fill={up ? 'url(#eqUp)' : 'url(#eqDown)'} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />

      {/* Square terminal marker, not a soft dot. */}
      <rect
        x={pts[pts.length - 1][0] - 3.5} y={pts[pts.length - 1][1] - 3.5}
        width={7} height={7} fill={color}
      />

      <text x={pad.l - 8} y={pad.t + 4} fill="var(--muted)" fontSize={10.5} textAnchor="end" fontFamily={MONO}>{fmt.usd(max)}</text>
      <text x={pad.l - 8} y={pad.t + ph / 2 + 4} fill="var(--dim)" fontSize={10.5} textAnchor="end" fontFamily={MONO}>{fmt.usd(midVal)}</text>
      <text x={pad.l - 8} y={pad.t + ph + 4} fill="var(--muted)" fontSize={10.5} textAnchor="end" fontFamily={MONO}>{fmt.usd(min)}</text>

      <text x={pad.l} y={h - 6} fill="var(--dim)" fontSize={10} fontFamily={MONO}>{new Date(points[0].ts).toLocaleTimeString()}</text>
      <text x={w - pad.r} y={h - 6} fill="var(--dim)" fontSize={10} textAnchor="end" fontFamily={MONO}>{new Date(points[points.length - 1].ts).toLocaleTimeString()}</text>

      <text x={w - pad.r} y={pad.t - 7} fill={color} fontSize={13} fontWeight={600} textAnchor="end" fontFamily={MONO}>
        {fmt.usd(last)}
      </text>
    </svg>
  );
}
