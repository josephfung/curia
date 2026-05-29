import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu';
import { Sidebar } from '../components/Sidebar';
import { Topbar } from '../components/Topbar';
import { useTheme } from '../hooks/useTheme';

export default function DashboardPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  function handleNavigate(view: string) {
    if (view === 'autonomy') {
      navigate({ to: '/settings/autonomy' }).catch(err => {
        console.error('[DashboardPage] navigation to /settings/autonomy failed:', err);
      });
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
