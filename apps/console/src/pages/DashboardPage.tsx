import { useState, useEffect } from 'react';
import { MobileMenuContext } from '../context/MobileMenu';
import { Sidebar } from '../components/Sidebar';
import { Topbar } from '../components/Topbar';

type Theme = 'light' | 'system' | 'dark';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('curia-theme') as Theme) ?? 'system';
    } catch (err) {
      console.error('[useTheme] failed reading curia-theme from localStorage:', err);
      return 'system';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
    try {
      localStorage.setItem('curia-theme', theme);
    } catch (err) {
      console.error('[useTheme] failed writing curia-theme to localStorage:', err);
    }
  }, [theme]);

  return [theme, setTheme];
}

export default function DashboardPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="dashboard" onNavigate={() => undefined} theme={theme} onThemeChange={setTheme} />
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
