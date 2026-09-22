// Shared stroke icon set — replaces emoji-as-icons in UI chrome.
// viewBox 24, stroke currentColor, aria-hidden (decorative only; keep text/aria-label context).
// Paths re-use the existing Sidebar nav SVG plus standard feather-style strokes.

interface IconProps {
  size?: number;
  className?: string;
}

function Icon({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
      className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

const p = (d: string) => <path d={d} />;

export const IconLayout = (x: IconProps) => <Icon {...x}>
  {p('M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z')}
</Icon>;

export const IconTrendingUp = (x: IconProps) => <Icon {...x}>
  {p('M23 6l-9.5 9.5-5-5L1 18')}
  {p('M17 6h6v6')}
</Icon>;

export const IconTrendingDown = (x: IconProps) => <Icon {...x}>
  {p('M23 18l-9.5-9.5-5 5L1 8')}
  {p('M17 18h6v-6')}
</Icon>;

export const IconStar = (x: IconProps) => <Icon {...x}>
  {p('M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z')}
</Icon>;

export const IconChartLine = (x: IconProps) => <Icon {...x}>
  {p('M18 20V10')}
  {p('M12 20V4')}
  {p('M6 20v-6')}
</Icon>;

export const IconZap = (x: IconProps) => <Icon {...x}>
  {p('M7 16V4M7 4L4 7.5M7 4l3.5 3.5')}
  {p('M17 8v12M17 20l3-3M17 20l-3-3')}
</Icon>;

export const IconBriefcase = (x: IconProps) => <Icon {...x}>
  {p('M2 7h20v13a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 20z')}
  {p('M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16')}
</Icon>;

export const IconBot = (x: IconProps) => <Icon {...x}>
  {p('M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4 4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z')}
  {p('M8 12v3a4 4 0 0 0 8 0v-3')}
  {p('M12 19v3M8 22h8')}
</Icon>;

export const IconFire = (x: IconProps) => <Icon {...x}>
  {p('M12 22c4.4 0 8-3.6 8-8 0-3-2-5-4-7-.5 2-1.5 3-2.5 4-.4-2-.8-3.4-1.5-5C9.5 7 7 9.6 7 13c0 .8-.2 1.5-.5 2.2A8.2 8.2 0 0 1 12 22z')}
</Icon>;

export const IconRocket = (x: IconProps) => <Icon {...x}>
  {p('M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8-.8-.7-2.2-.7-3 .8z')}
  {p('M12 14.5L9 11.5a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-1.8 6.6-6 9a22 22 0 0 1-4 3.5z')}
  {p('M9 11.5H4s.5-3 2-4c1.5-1 3-1 3-1')}
  {p('M12 14.5v5s3-.5 4-2c1-1.5 1-3 1-3')}
</Icon>;

export const IconDroplet = (x: IconProps) => <Icon {...x}>
  {p('M12 2.7s6 6.3 6 10.3a6 6 0 0 1-12 0C6 9 12 2.7 12 2.7z')}
</Icon>;

export const IconGem = (x: IconProps) => <Icon {...x}>
  {p('M6 3h12l4 6-10 12L2 9z')}
  {p('M2 9h20M12 21L8 9l4-6 4 6-4 12')}
</Icon>;

export const IconArrowUp = (x: IconProps) => <Icon {...x}>
  {p('M12 19V5M5 12l7-7 7 7')}
</Icon>;

export const IconArrowDown = (x: IconProps) => <Icon {...x}>
  {p('M12 5v14M19 12l-7 7-7-7')}
</Icon>;

export const IconCheck = (x: IconProps) => <Icon {...x}>
  {p('M20 6L9 17l-5-5')}
</Icon>;

export const IconX = (x: IconProps) => <Icon {...x}>
  {p('M18 6L6 18M6 6l12 12')}
</Icon>;

export const IconClock = (x: IconProps) => <Icon {...x}>
  {p('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z')}
  {p('M12 7v5l3 2')}
</Icon>;

export const IconPause = (x: IconProps) => <Icon {...x}>
  {p('M8 5v14M16 5v14')}
</Icon>;

export const IconPlay = (x: IconProps) => <Icon {...x}>
  {p('M8 5v14l11-7z')}
</Icon>;

export const IconAlert = (x: IconProps) => <Icon {...x}>
  {p('M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z')}
  {p('M12 9v4M12 17h.01')}
</Icon>;

export const IconInfo = (x: IconProps) => <Icon {...x}>
  {p('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z')}
  {p('M12 16v-4M12 8h.01')}
</Icon>;

export const IconSettings = (x: IconProps) => <Icon {...x}>
  {p('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z')}
  {p('M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.9 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.6H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 6 6.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 .3 1.8z')}
</Icon>;

export const IconKey = (x: IconProps) => <Icon {...x}>
  {p('M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m2 2l2-2')}
</Icon>;

export const IconShield = (x: IconProps) => <Icon {...x}>
  {p('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z')}
  {p('M9 12l2 2 4-4')}
</Icon>;

export const IconLock = (x: IconProps) => <Icon {...x}>
  {p('M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z')}
  {p('M8 11V7a4 4 0 0 1 8 0v4')}
</Icon>;

export const IconSparkles = (x: IconProps) => <Icon {...x}>
  {p('M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z')}
  {p('M19 15l.9 2.6L22 18.5l-2.1.9L19 22l-.9-2.6-2.1-.9 2.1-.9z')}
</Icon>;

export const IconScroll = (x: IconProps) => <Icon {...x}>
  {p('M6 2h12v20H6z')}
  {p('M9 7h6M9 11h6M9 15h4')}
</Icon>;

export const IconWallet = (x: IconProps) => <Icon {...x}>
  {p('M21 12V7H5a2 2 0 0 1 0-4h14v4')}
  {p('M3 5v14a2 2 0 0 0 2 2h16v-5')}
  {p('M18 12a2 2 0 0 0 0 4h4v-4z')}
</Icon>;

export const IconPower = (x: IconProps) => <Icon {...x}>
  {p('M18.4 6.6a9 9 0 1 1-12.8 0')}
  {p('M12 2v10')}
</Icon>;

// Aliases used by page imports (clearer names; same paths).
export const IconBolt = IconZap;
export const IconChartBar = IconLayout;
export const IconClose = IconX;
export const IconGear = IconSettings;