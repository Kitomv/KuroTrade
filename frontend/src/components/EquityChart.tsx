import { IconChartLine } from './Icons';
import { fmt } from '../lib/format';

interface Point {
  ts: number;
  totalValue: number;
}

/** SVG equity curve — area fill + line, coloring by net trend. */
export function EquityChart({ points }: { points: Point[] }) {
  const w = 720;
  const h = 200;
  const pad = { l: 60, r: 16, t: 20, b: 24 };
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
  const color = up ? '#22c55e' : '#ef4444';

  const pts = points.map((p, i) => {
    const x = pad.l + (i / (points.length - 1)) * pw;
    const y = pad.t + ph - ((p.totalValue - min) / range) * ph;
    return [x, y] as const;
  });

  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${(pad.t + ph).toFixed(1)} L${pts[0][0].toFixed(1)},${(pad.t + ph).toFixed(1)} Z`;

  const midVal = (max + min) / 2;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', width: '100%', height: 'auto', background: 'var(--panel-2)', borderRadius: 10 }}>
      <defs>
        <linearGradient id="eqUp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="eqDown" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ef4444" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
        </linearGradient>
      </defs>

      <line x1={pad.l} y1={pad.t} x2={pad.l + pw} y2={pad.t} stroke="var(--border)" strokeDasharray="3 3" opacity="0.5" />
      <line x1={pad.l} y1={pad.t + ph / 2} x2={pad.l + pw} y2={pad.t + ph / 2} stroke="var(--border)" strokeDasharray="3 3" opacity="0.5" />
      <line x1={pad.l} y1={pad.t + ph} x2={pad.l + pw} y2={pad.t + ph} stroke="var(--border)" />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ph} stroke="var(--border)" />

      <path d={areaPath} fill={up ? 'url(#eqUp)' : 'url(#eqDown)'} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />

      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={4.5} fill={color} />

      <text x={pad.l - 8} y={pad.t + 4} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">{fmt.usd(max)}</text>
      <text x={pad.l - 8} y={pad.t + ph / 2 + 4} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">{fmt.usd(midVal)}</text>
      <text x={pad.l - 8} y={pad.t + ph + 4} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="var(--font-body)">{fmt.usd(min)}</text>

      <text x={pad.l} y={h - 6} fill="var(--muted)" fontSize={10} fontFamily="var(--font-body)">{new Date(points[0].ts).toLocaleTimeString()}</text>
      <text x={w - pad.r} y={h - 6} fill="var(--muted)" fontSize={10} textAnchor="end" fontFamily="var(--font-body)">{new Date(points[points.length - 1].ts).toLocaleTimeString()}</text>

      <text x={w - pad.r} y={pad.t - 6} fill={color} fontSize={13} fontWeight={700} textAnchor="end" fontFamily="var(--font-body)">
        {fmt.usd(last)}
      </text>
    </svg>
  );
}