import { useEffect, useRef, useState } from 'react';
import { CountUp } from './CountUp';

interface Props {
  label: string;
  value: string | number;
  sub?: string;
  variant?: 'up' | 'down';
}

export function KpiCard({ label, value, sub, variant }: Props) {
  const [flashing, setFlashing] = useState(false);
  const prevRef = useRef(value);

  useEffect(() => {
    if (prevRef.current !== value) {
      setFlashing(true);
      const id = setTimeout(() => setFlashing(false), 600);
      prevRef.current = value;
      return () => clearTimeout(id);
    }
  }, [value]);

  const color = variant === 'up' ? 'var(--up)' : variant === 'down' ? 'var(--down)' : 'var(--text)';

  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={`value${flashing ? ' flash' : ''}`} style={{ color }}>
        {typeof value === 'number' ? <CountUp value={value} format={(n) => (n % 1 === 0 && n < 1e9 ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }))} /> : value}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}