// Count-up number — springs from previous to new value over ~600ms (rAF ease-out).
// Importers/callers: KpiCard (numeric values). API: `<CountUp value format/>`:
// `format` maps a number to its display string (e.g. fmt.usd); without it renders
// plain toLocaleString. Presentational, no data schema. User instruction:
// "ui ux set futuristik plan" → Neon Cyber.
import { useEffect, useRef, useState } from 'react';

const DURATION = 600;

export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      setDisplay(from + (value - from) * easeOut(t));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      fromRef.current = value;
    };
  }, [value]);

  return <>{format ? format(display) : display.toLocaleString(undefined, { maximumFractionDigits: 6 })}</>;
}