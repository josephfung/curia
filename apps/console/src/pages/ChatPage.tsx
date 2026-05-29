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
  const { messages, sending, send } = useChatSession();

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  function handleNavigate(view: string) {
    if (view === 'autonomy') {
      navigate({ to: '/settings/autonomy' }).catch(err => {
        console.error('[ChatPage] navigation to /settings/autonomy failed:', err);
      });
    }
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="chat" onNavigate={handleNavigate} theme={theme} onThemeChange={setTheme} />
        <main className="main">
          <Topbar crumb="Curia" title="Chat" />
          <div className="chat-page">
            <ChatThread messages={messages} />
            <ChatComposer disabled={sending} onSend={send} />
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
