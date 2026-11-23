import { useCallback, useEffect, useState } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { useTheme } from '../hooks/useTheme.js';
import { getGreeting, greetingSubtitle, hourInTimeZone } from './dashboard/dashboard-utils.js';
import { WaitingOnYou } from './dashboard/WaitingOnYou.js';
import { BigNumbers } from './dashboard/BigNumbers.js';
import { WorkHistogram } from './dashboard/WorkHistogram.js';
import { AskCuria } from './dashboard/AskCuria.js';
import { Bullpen } from './dashboard/Bullpen.js';
import { HealthCard } from './dashboard/HealthCard.js';
import { ActivityFeed } from './dashboard/ActivityFeed.js';
import { OnboardingAlert } from './dashboard/OnboardingAlert.js';

// Principal home (#2340). Each card loads on its own. The greeting uses the
// waiting count and the "handled since yesterday" count only after those
// cards have loaded — a failure stays blank rather than reading as zero.
export default function DashboardPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [waitingCount, setWaitingCount] = useState<number | null>(null);
  const [handled, setHandled] = useState<number | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [hour, setHour] = useState(() => new Date().getHours());
  const rememberZone = useCallback((next: string) => {
    setZone((prev) => prev ?? next);
  }, []);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  useEffect(() => {
    if (zone) setHour(hourInTimeZone(new Date(), zone));
  }, [zone]);

  const subtitle = greetingSubtitle(waitingCount, handled);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="dashboard" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Console" title="Home" />

          <div className="dash-scroll">
            <div className="dash-inner">
              <div className="dash-greeting">
                <h2 className="dash-greeting-title">{getGreeting(hour)}.</h2>
                <p className="dash-greeting-sub">{subtitle || '\u00a0'}</p>
              </div>

              <OnboardingAlert />
              <WaitingOnYou onVisibleCount={setWaitingCount} onTimezone={rememberZone} />
              <BigNumbers onHandled={setHandled} onTimezone={rememberZone} />

              <div className="dash-split">
                <div className="dash-col">
                  <WorkHistogram />
                  <AskCuria />
                  <Bullpen />
                  <HealthCard />
                </div>
                <ActivityFeed />
              </div>
            </div>
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
