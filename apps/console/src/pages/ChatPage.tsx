import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu';
import { Sidebar } from '../components/Sidebar';
import { Topbar } from '../components/Topbar';
import { useTheme } from '../hooks/useTheme';
import { ChatThread } from './chat/ChatThread';
import { ChatComposer } from './chat/ChatComposer';
import { useChatSession } from './chat/useChatSession';

export default function ChatPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { messages, sending, hasMore, loadingHistory, send, loadMore } = useChatSession();

  useEffect(() => {
    if (mobileOpen) {
      document.documentElement.dataset['mobileSidebar'] = 'open';
    } else {
      delete document.documentElement.dataset['mobileSidebar'];
    }
    return () => { delete document.documentElement.dataset['mobileSidebar']; };
  }, [mobileOpen]);

  function handleNavigate(view: string) {
    const routes: Record<string, string> = {
      contacts: '/contacts',
      jobs:     '/jobs',
      kg:       '/kg',
      tasks:    '/',
      settings: '/settings',
      wizard:   '/setup',
      autonomy: '/settings/autonomy',
    };
    const to = routes[view];
    if (!to) return;
    navigate({ to }).catch((err: unknown) => {
      console.error(`[ChatPage] navigation to ${to} failed:`, err);
    });
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="chat" onNavigate={handleNavigate} theme={theme} onThemeChange={setTheme} />
        <main className="main">
          <Topbar crumb="Curia" title="Chat" />
          <div className="chat-page">
            <ChatThread
              messages={messages}
              hasMore={hasMore}
              loadingHistory={loadingHistory}
              loadMore={loadMore}
            />
            <ChatComposer disabled={sending} onSend={send} />
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
