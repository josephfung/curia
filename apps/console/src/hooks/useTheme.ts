import { useState, useEffect } from 'react';

export type Theme = 'light' | 'system' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('curia-theme');
      if (stored === 'light' || stored === 'system' || stored === 'dark') return stored;
      return 'system';
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
