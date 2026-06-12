import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMobileMenu } from '../context/MobileMenu';
import { apiFetch } from '../api.js';
import {
  CuriaWordmark,
  IconChat,
  IconMemory,
  IconGraph,
  IconPerson,
  IconChecklist,
  IconClock,
  IconSettings,
  IconWand,
  IconAutonomy,
  IconChevron,
} from './Icons';

type Theme = 'light' | 'system' | 'dark';

interface SidebarProps {
  activeView: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

const ROUTES: Record<string, string> = {
  chat:     '/chat',
  kg:       '/kg',
  contacts: '/contacts',
  tasks:    '/tasks',
  jobs:     '/jobs',
  skills:   '/skills',
  agents:   '/agents',
  channels: '/channels',
  settings: '/settings/workspace',
};

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const options: Array<{ v: Theme; label: string }> = [
    { v: 'light', label: 'Light' },
    { v: 'system', label: 'Auto' },
    { v: 'dark', label: 'Dark' },
  ];
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {options.map((opt) => (
        <button
          key={opt.v}
          type="button"
          className={`theme-toggle-btn${theme === opt.v ? ' active' : ''}`}
          aria-pressed={theme === opt.v}
          onClick={() => onChange(opt.v)}
          title={`${opt.label} theme`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function getInitials(name: string | null): string {
  if (!name) return '···';
  const trimmed = name.trim();
  if (!trimmed) return '···';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return ((parts[0] ?? '')[0] ?? '').toUpperCase() + ((parts[parts.length - 1] ?? '')[0] ?? '').toUpperCase();
}

export function Sidebar({ activeView, theme, onThemeChange }: SidebarProps) {
  const [memoryOpen, setMemoryOpen] = useState(true);
  // Expand the Settings group when on any of its pages (Skills/Agents are now
  // standalone pages but still live under the sidebar's Settings group).
  const [settingsOpen, setSettingsOpen] = useState(
    activeView === 'settings' || activeView === 'skills' || activeView === 'agents' || activeView === 'channels',
  );
  const [principalName, setPrincipalName] = useState<string | null>(null);
  const { setOpen } = useMobileMenu();
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/kg/contacts', { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`/api/kg/contacts returned ${r.status}`);
        return r.json();
      })
      .then((data: { contacts: Array<{ displayName: string; systemRole?: string | null }> }) => {
        const principal = data.contacts.find(c => c.systemRole === 'principal');
        if (principal) setPrincipalName(principal.displayName);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Non-fatal: sidebar degrades to placeholders, but log so the cause is visible.
        console.error('[Sidebar] Failed to load principal contact:', err);
      });
    return () => controller.abort();
  }, []);

  const go = (view: string) => {
    const to = ROUTES[view];
    if (to) {
      navigate({ to }).catch((err: unknown) => {
        console.error(`[Sidebar] navigation to ${to} failed:`, err);
      });
    } else {
      console.error(`[Sidebar] go() called with unknown view key: "${view}"`);
    }
    setOpen(false);
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-wordmark" aria-label="Curia">
        <CuriaWordmark />
      </div>

      <div className="nav-group">
        <button
          className={`nav-item${activeView === 'chat' ? ' active' : ''}`}
          onClick={() => go('chat')}
        >
          <IconChat />
          Chat
        </button>

        <div>
          <button className="nav-item" onClick={() => setMemoryOpen(!memoryOpen)}>
            <IconMemory />
            Memory
            <IconChevron collapsed={!memoryOpen} />
          </button>
          {memoryOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
              <button
                className={`nav-sub-item${activeView === 'kg' ? ' active' : ''}`}
                onClick={() => go('kg')}
              >
                <IconGraph />
                Knowledge Graph
              </button>
              <button
                className={`nav-sub-item${activeView === 'contacts' ? ' active' : ''}`}
                onClick={() => go('contacts')}
              >
                <IconPerson />
                Contacts
              </button>
              <button
                className={`nav-sub-item${activeView === 'tasks' ? ' active' : ''}`}
                onClick={() => go('tasks')}
              >
                <IconChecklist />
                Tasks
              </button>
              <button
                className={`nav-sub-item${activeView === 'jobs' ? ' active' : ''}`}
                onClick={() => go('jobs')}
              >
                <IconClock />
                Scheduled Jobs
              </button>
            </div>
          )}
        </div>

        <div>
          <button className="nav-item" onClick={() => setSettingsOpen(!settingsOpen)}>
            <IconSettings />
            Settings
            <IconChevron collapsed={!settingsOpen} />
          </button>
          {settingsOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
              <button
                className={`nav-sub-item${activeView === 'skills' ? ' active' : ''}`}
                onClick={() => go('skills')}
              >
                <IconWand />
                Skills
              </button>
              <button
                className={`nav-sub-item${activeView === 'agents' ? ' active' : ''}`}
                onClick={() => go('agents')}
              >
                <IconAutonomy />
                Agents
              </button>
              <button
                className={`nav-sub-item${activeView === 'channels' ? ' active' : ''}`}
                onClick={() => go('channels')}
              >
                <IconWand />
                Channels
              </button>
              <button
                className={`nav-sub-item${activeView === 'settings' ? ' active' : ''}`}
                onClick={() => go('settings')}
              >
                <IconSettings />
                Workspace
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <ThemeToggle theme={theme} onChange={onThemeChange} />
        <button className="sidebar-user">
          <span className="sidebar-user-avatar">{getInitials(principalName)}</span>
          <span className="sidebar-user-meta">
            <span className="sidebar-user-name">{principalName ?? 'Setting up…'}</span>
            <span className="sidebar-user-org">v{__APP_VERSION__}</span>
          </span>
        </button>
      </div>
    </nav>
  );
}
