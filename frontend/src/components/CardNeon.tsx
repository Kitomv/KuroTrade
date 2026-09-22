// Neon energy card wrapper — adds the animated gradient border ring.
// Importers/callers: Overview/Portfolio/Agents/Login (key semantic cards).
// API: `<CardNeon className={...}>children</CardNeon>` → div.card.card-neon.
// No data schema — presentational. User instruction: "ui ux set futuristik plan" → Neon Cyber (aman).
import { ReactNode } from 'react';

export function CardNeon({ className, style, children }: { className?: string; style?: React.CSSProperties; children: ReactNode }) {
  return (
    <div className={`card card-neon${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}