import { useState } from 'react';
import { useMobileMenu } from '../context/MobileMenu';
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
  IconChevron,
} from './Icons';

type Theme = 'light' | 'system' | 'dark';

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

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
          className={`theme-toggle-btn${theme === opt.v ? ' active' : ''}`}
          onClick={() => onChange(opt.v)}
          title={`${opt.label} theme`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ activeView, onNavigate, theme, onThemeChange }: SidebarProps) {
  const [memoryOpen, setMemoryOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { setOpen } = useMobileMenu();

  const go = (v: string) => {
    onNavigate(v);
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
                className={`nav-sub-item${activeView === 'settings' ? ' active' : ''}`}
                onClick={() => go('settings')}
              >
                <IconSettings />
                Workspace
              </button>
              <button
                className={`nav-sub-item${activeView === 'wizard' ? ' active' : ''}`}
                onClick={() => go('wizard')}
              >
                <IconWand />
                Setup Wizard
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <ThemeToggle theme={theme} onChange={onThemeChange} />
        <button className="sidebar-user">
          <span className="sidebar-user-avatar">JF</span>
          <span className="sidebar-user-meta">
            <span className="sidebar-user-name">Joseph Fung</span>
            <span className="sidebar-user-org">Curia · admin</span>
          </span>
        </button>
      </div>
    </nav>
  );
}
