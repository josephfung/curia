import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu';
import { Sidebar } from '../components/Sidebar';
import { Topbar } from '../components/Topbar';
import { useTheme } from '../hooks/useTheme.js';

export default function DashboardPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  function handleNavigate(view: string) {
    if (view === 'autonomy') {
      void navigate({ to: '/settings/autonomy' });
    }
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="dashboard" onNavigate={handleNavigate} theme={theme} onThemeChange={setTheme} />
        <main className="main">
          <Topbar crumb="Console" title="Dashboard" />
          <div className="placeholder-body">
            Console — coming soon.
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
