import type { ReactNode } from 'react';
import { useMobileMenu } from '../context/MobileMenu';

interface TopbarProps {
  crumb?: string;
  title: string;
  children?: ReactNode;
}

export function Topbar({ crumb, title, children }: TopbarProps) {
  const { setOpen } = useMobileMenu();
  return (
    <header className="topbar">
      <button
        className="mobile-menu-btn"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        type="button"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <div className="topbar-title">
        {crumb && <div className="topbar-crumb">{crumb}</div>}
        <h1 className="topbar-h1">{title}</h1>
      </div>
      <div className="topbar-controls">{children}</div>
    </header>
  );
}

interface TopbarSearchProps {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
}

export function TopbarSearch({ placeholder, value, onChange, onSubmit }: TopbarSearchProps) {
  return (
    <div className="topbar-search">
      <svg
        className="topbar-search-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.5" y2="16.5" />
      </svg>
      <input
        type="text"
        aria-label={placeholder ?? 'Search'}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit?.();
        }}
      />
    </div>
  );
}

export function TopbarDivider() {
  return <span className="topbar-divider" aria-hidden="true" />;
}
