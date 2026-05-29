// Curia — Lucide icon set, inlined. ISC-licensed; lucide.dev.
import type { SVGProps, ReactNode } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  children?: ReactNode;
}

function Icon({ children, size = 16, viewBox = '0 0 24 24', strokeWidth = 2, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconChat({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

export function IconMemory({ size }: IconProps) {
  return (
    <Icon size={size}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Icon>
  );
}

export function IconGraph({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="2" />
      <circle cx="4" cy="4" r="2" />
      <circle cx="20" cy="4" r="2" />
      <circle cx="4" cy="20" r="2" />
      <circle cx="20" cy="20" r="2" />
      <line x1="5.4" y1="5.4" x2="10.6" y2="10.6" />
      <line x1="18.6" y1="5.4" x2="13.4" y2="10.6" />
      <line x1="10.6" y1="13.4" x2="5.4" y2="18.6" />
      <line x1="18.6" y1="18.6" x2="13.4" y2="13.4" />
    </Icon>
  );
}

export function IconPerson({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  );
}

export function IconChecklist({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <polyline points="9 12 11 14 16 9" />
    </Icon>
  );
}

export function IconClock({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Icon>
  );
}

export function IconSettings({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

export function IconWand({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </Icon>
  );
}

export function IconChevron({ collapsed }: { collapsed?: boolean }) {
  return (
    <svg
      className={`chevron${collapsed ? ' collapsed' : ''}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconSearch({ size }: IconProps) {
  return (
    <Icon size={size}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  );
}

export function IconPlus({ size }: IconProps) {
  return (
    <Icon size={size}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Icon>
  );
}

export function IconSend({ size }: IconProps) {
  return (
    <Icon size={size}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9" />
    </Icon>
  );
}

export function IconAutonomy({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 2a10 10 0 0 1 7.38 16.75" />
      <path d="M4.62 18.75A10 10 0 0 1 12 2" />
      <circle cx="12" cy="12" r="1" />
      <line x1="12" y1="11" x2="16" y2="7" />
    </Icon>
  );
}

// Inline Curia wordmark SVG — uses currentColor for theme tracking
export function CuriaWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 3024 690" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path fill="currentColor" fillRule="nonzero" d="M353.581 10.0006C163.722 10.0004 9.81112 163.911 9.81112 353.77C9.81106 498.564 99.4541 622.21 226.165 672.864L239.837 659.126L309.763 589.2C309.784 589.204 309.807 589.197 309.828 589.2L353.581 545.383L397.398 589.2L461.074 652.876L480.997 672.864C607.707 622.211 697.351 498.564 697.351 353.77C697.351 163.912 543.44 10.0007 353.581 10.0006ZM353.581 114.173C485.907 114.173 593.178 221.445 593.178 353.77C593.178 431.275 556.255 499.947 499.162 543.69L427.218 471.746L454.042 444.921L453.782 444.661C475.604 420.619 489.005 388.796 489.005 353.77C489.005 278.977 428.374 218.346 353.581 218.346C278.788 218.346 218.156 278.977 218.156 353.77C218.156 390.521 232.805 423.842 256.57 448.242L256.505 448.307L279.944 471.746L208 543.625C150.925 499.881 113.984 431.261 113.984 353.77C113.984 221.445 221.255 114.173 353.581 114.173ZM353.581 322.519C370.841 322.519 384.833 336.511 384.833 353.77C384.833 362.451 381.237 370.244 375.522 375.907L375.652 376.037L353.581 398.109L331.509 376.037L331.639 375.907C325.925 370.244 322.329 362.451 322.329 353.77C322.329 336.51 336.321 322.519 353.581 322.519Z" />
      <path fill="currentColor" fillRule="nonzero" d="M1670.51 594.763C1627.62 594.763 1591.42 586.709 1561.89 570.602C1532.37 554.494 1509.92 531.731 1494.54 502.312C1479.15 472.893 1471.46 438.191 1471.46 398.207L1471.46 128.932L1573.39 128.932L1573.39 401.936C1573.39 421.617 1577.17 438.839 1584.74 453.6C1592.3 468.361 1603.28 479.73 1617.68 487.706C1632.07 495.682 1649.68 499.67 1670.51 499.67C1691.33 499.67 1708.91 495.708 1723.26 487.784C1737.6 479.859 1748.48 468.594 1755.89 453.988C1763.29 439.383 1767 422.032 1767 401.936L1767 128.932L1868.93 128.932L1868.93 398.207C1868.93 438.191 1861.34 472.893 1846.16 502.312C1830.99 531.731 1808.66 554.494 1779.19 570.602C1749.72 586.709 1713.49 594.763 1670.51 594.763Z" />
      <path fill="currentColor" fillRule="nonzero" d="M1951.74 582.644L1951.74 125.514L2053.67 125.514L2053.67 582.644L1951.74 582.644ZM2226.92 582.644L2093.76 387.641L2205.79 387.641L2345.16 582.644L2226.92 582.644ZM2026.01 437.207L2026.01 357.031L2138.04 357.031C2153.06 357.031 2166.01 354.027 2176.88 348.019C2187.76 342.011 2196.23 333.542 2202.29 322.614C2208.35 311.686 2211.38 299.022 2211.38 284.623C2211.38 269.914 2208.35 257.095 2202.29 246.167C2196.23 235.238 2187.76 226.744 2176.88 220.684C2166.01 214.624 2153.06 211.594 2138.04 211.594L2026.01 211.594L2026.01 125.514L2130.11 125.514C2167.92 125.514 2200.66 131.185 2228.32 142.528C2255.97 153.871 2277.26 170.755 2292.18 193.182C2307.09 215.608 2314.55 243.655 2314.55 277.321L2314.55 287.265C2314.55 320.931 2306.99 348.822 2291.87 370.937C2276.74 393.053 2255.46 409.627 2228 420.659C2200.55 431.691 2167.92 437.207 2130.11 437.207L2026.01 437.207Z" />
      <path fill="currentColor" fillRule="nonzero" d="M2396.28 582.644L2396.28 128.932L2500.45 128.932L2500.45 582.644L2396.28 582.644Z" />
      <path fill="currentColor" fillRule="nonzero" d="M2548.08 582.644L2698.02 128.932L2862.72 128.932L3017.64 582.644L2912.44 582.644L2786.74 199.475L2818.9 212.527L2739.04 212.527L2772.13 199.475L2650.01 582.644L2548.08 582.644ZM2661.5 469.993L2692.73 385.465L2870.8 385.465L2902.03 469.993L2661.5 469.993Z" />
      <path fill="currentColor" fillRule="nonzero" d="M973.772 355.789C973.772 488.115 1081.04 595.386 1213.37 595.386C1291.91 595.386 1361.35 557.422 1405.05 499.026L1330.11 424.087C1306.6 464.19 1263.21 491.214 1213.37 491.213C1138.58 491.213 1077.95 430.582 1077.95 355.789C1077.95 280.996 1138.58 220.364 1213.37 220.365C1262.78 220.365 1305.8 246.93 1329.46 286.449L1404.33 211.575C1360.59 153.731 1291.48 116.192 1213.37 116.192C1081.04 116.192 973.772 223.463 973.772 355.789Z" />
    </svg>
  );
}
