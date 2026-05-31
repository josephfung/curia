import { useState, useEffect } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { useTheme } from '../hooks/useTheme.js';
import { ChatThread } from './chat/ChatThread.js';
import { ChatComposer } from './chat/ChatComposer.js';
import { useChatSession } from './chat/useChatSession.js';

export default function ChatPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { messages, sending, hasMore, loadingHistory, send, loadMore } = useChatSession();

  useEffect(() => {
    if (mobileOpen) {
      document.documentElement.dataset['mobileSidebar'] = 'open';
    } else {
      delete document.documentElement.dataset['mobileSidebar'];
    }
    return () => { delete document.documentElement.dataset['mobileSidebar']; };
  }, [mobileOpen]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="chat" theme={theme} onThemeChange={setTheme} />
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
