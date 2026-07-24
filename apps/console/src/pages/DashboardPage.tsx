import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { IconChat } from '../components/Icons.js';
import { useTheme } from '../hooks/useTheme.js';
import { getGreeting } from './dashboard/dashboard-utils.js';
import { HealthCard } from './dashboard/HealthCard.js';
import { AttentionList } from './dashboard/AttentionList.js';
import { ActivityFeed } from './dashboard/ActivityFeed.js';
import { AntFarmPromo } from './dashboard/AntFarmPromo.js';

// Operator status home — the default `/` landing page (issue #1375). Composes
// independently-fetching cards (health, attention, activity) plus an "Ask Curia"
// chat CTA and the Ant Farm promo. Chat itself lives at /chat; this page links
// to it and never re-implements the chat UI.
export default function DashboardPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Greeting only needs the current hour; compute once on mount.
  const [greeting] = useState(() => getGreeting(new Date().getHours()));

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

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
                <h2 className="dash-greeting-title">{greeting}.</h2>
                <p className="dash-greeting-sub">Here’s the state of your instance at a glance.</p>
              </div>

              <section className="dash-grid">
                <HealthCard />
                <AttentionList />
                <ActivityFeed />
              </section>

              <section className="dash-ask">
                <div className="dash-ask-copy">
                  <h3 className="dash-ask-title">Ask Curia</h3>
                  <p className="dash-ask-text">
                    Put a question to the bullpen — it has the graph, the jobs and the audit trail in
                    front of it.
                  </p>
                </div>
                <Link to="/chat" className="btn dash-ask-cta">
                  <IconChat />
                  Open chat
                </Link>
              </section>

              <AntFarmPromo />
            </div>
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
