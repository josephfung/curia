// The sidebar footer's user menu: the principal's name and the version, which
// open a small menu with the theme, Devices & notifications, and Log out.
// Personal settings (a future password change, say) belong here too.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { IconBell, IconLogOut, IconSelector } from './Icons';
import { nextMenuIndex } from './user-menu-keys';

export type Theme = 'light' | 'system' | 'dark';

const THEMES: Array<{ v: Theme; label: string }> = [
  { v: 'light', label: 'Light' },
  { v: 'system', label: 'Auto' },
  { v: 'dark', label: 'Dark' },
];

function menuItemsIn(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
}

interface UserMenuProps {
  initials: string;
  name: string;
  version: string | null;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onDevices: () => void;
  onLogOut: () => void;
  logoutError: string | null;
}

export function UserMenu({
  initials,
  name,
  version,
  theme,
  onThemeChange,
  onDevices,
  onLogOut,
  logoutError,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // A failed logout keeps the menu open so the error is seen where it was asked for.
  useEffect(() => {
    if (logoutError) setOpen(true);
  }, [logoutError]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    // Focus the selected theme, so the keyboard starts somewhere meaningful.
    const items = menuItemsIn(panelRef.current);
    const selected = items.find((item) => item.getAttribute('aria-checked') === 'true');
    (selected ?? items[0])?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close(event.key === 'Escape');
      return;
    }
    const items = menuItemsIn(panelRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextMenuIndex(event.key, current, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="user-menu" ref={rootRef}>
      {open && (
        <div
          id={panelId}
          ref={panelRef}
          className="user-menu-panel"
          role="menu"
          aria-label="Account"
          onKeyDown={onPanelKeyDown}
        >
          <div className="user-menu-label" id={`${panelId}-theme`}>Theme</div>
          <div className="theme-toggle user-menu-theme" role="group" aria-labelledby={`${panelId}-theme`}>
            {THEMES.map((opt) => (
              <button
                key={opt.v}
                type="button"
                role="menuitemradio"
                aria-checked={theme === opt.v}
                tabIndex={-1}
                className={`theme-toggle-btn${theme === opt.v ? ' active' : ''}`}
                onClick={() => onThemeChange(opt.v)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="user-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="user-menu-item"
            onClick={() => {
              close(false);
              onDevices();
            }}
          >
            <IconBell size={15} aria-hidden="true" />
            Devices &amp; notifications
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="user-menu-item"
            onClick={onLogOut}
          >
            <IconLogOut size={15} aria-hidden="true" />
            Log out
          </button>
          {logoutError && <p className="user-menu-error" role="alert">{logoutError}</p>}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className={`sidebar-user${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="sidebar-user-avatar" aria-hidden="true">{initials}</span>
        <span className="sidebar-user-meta">
          <span className="sidebar-user-name">{name}</span>
          <span className="sidebar-user-org">{version ? `v${version}` : ''}</span>
        </span>
        <IconSelector size={14} className="sidebar-user-selector" aria-hidden="true" />
      </button>
    </div>
  );
}
