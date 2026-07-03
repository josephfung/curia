import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SceneDirective } from '@curia/shared-types';
import { apiFetch, checkSession } from './api.js';
import { OfficeView } from './components/OfficeView.js';
import { TransportBar } from './components/TransportBar.js';
import { BookmarkPanel } from './components/BookmarkPanel.js';
import { useTimeline } from './hooks/useTimeline.js';
import { useLiveStream } from './hooks/useLiveStream.js';
import { useConductor } from './hooks/useConductor.js';
import {
  addBookmark,
  loadBookmarks,
  removeBookmark,
  type AntfarmBookmark,
} from './bookmarks/bookmarks.js';
import {
  agentIdsFromDirectives,
  buildDeskLayout,
  ensureAgentDesk,
  type RegistryAgent,
} from './layout/desk-layout.js';
import { totalAnimationDurationMs } from './conductor/schedule.js';

function filterDirectives(
  directives: SceneDirective[],
  conversationId: string,
  agentId: string,
  kind: string,
): SceneDirective[] {
  return directives.filter((d) => {
    if (kind && d.kind !== kind) return false;
    if (agentId && 'agentId' in d && d.agentId !== agentId) return false;
    if (conversationId) {
      const conv =
        ('conversationId' in d && d.conversationId === conversationId)
        || false;
      if (!conv && agentId === '' && kind === '') {
        // conversation filter only applies to tube directives
        if (d.kind === 'tube.in' || d.kind === 'tube.out') return false;
      } else if (conversationId && (d.kind === 'tube.in' || d.kind === 'tube.out')) {
        if ('conversationId' in d && d.conversationId !== conversationId) return false;
      }
    }
    return true;
  });
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [registryAgents, setRegistryAgents] = useState<RegistryAgent[]>([]);
  const [bookmarks, setBookmarks] = useState<AntfarmBookmark[]>(() => loadBookmarks());
  const [liveMode, setLiveMode] = useState(false);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterConversation, setFilterConversation] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterKind, setFilterKind] = useState('');

  const { script, loading, error, fetchTimeline } = useTimeline();
  const live = useLiveStream(liveMode);
  const { snapshot, conductor, refresh } = useConductor();

  useEffect(() => {
    void checkSession().then(setAuthed);
    void apiFetch('/api/registry/agents')
      .then((res) => res.ok ? res.json() : { agents: [] })
      .then((data: { agents?: RegistryAgent[] }) => setRegistryAgents(data.agents ?? []))
      .catch(() => setRegistryAgents([]));
  }, []);

  const filteredDirectives = useMemo(() => {
    const base = snapshot.directives;
    return filterDirectives(base, filterConversation, filterAgent, filterKind);
  }, [snapshot.directives, filterConversation, filterAgent, filterKind]);

  const desks = useMemo(() => {
    let layout = buildDeskLayout(registryAgents, agentIdsFromDirectives(filteredDirectives));
    for (const id of agentIdsFromDirectives(filteredDirectives)) {
      layout = ensureAgentDesk(layout, id);
    }
    return layout;
  }, [registryAgents, filteredDirectives]);

  const activeDirective = snapshot.schedule[snapshot.firedIndex]?.directive ?? null;

  const loadWindow = useCallback(async (windowFrom: string, windowTo: string, conv?: string) => {
    if (liveMode && live.streamOpenTs !== null) {
      const replay = await fetchTimeline({
        from: windowFrom || undefined,
        to: new Date(live.streamOpenTs).toISOString(),
        conversationId: conv,
      });
      conductor.mergeLiveBuffer(replay.directives, live.buffer, live.streamOpenTs);
    } else {
      const data = await fetchTimeline({
        from: windowFrom || undefined,
        to: windowTo || undefined,
        conversationId: conv,
      });
      conductor.loadScript(data);
    }
    refresh();
  }, [conductor, fetchTimeline, live.buffer, live.streamOpenTs, liveMode, refresh]);

  useEffect(() => {
    if (script && !liveMode) {
      conductor.loadScript(script);
      refresh();
    }
  }, [script, liveMode, conductor, refresh]);

  useEffect(() => {
    if (liveMode && live.streamOpenTs && live.buffer.length > 0 && script) {
      conductor.mergeLiveBuffer(script.directives, live.buffer, live.streamOpenTs);
      refresh();
    }
  }, [liveMode, live.buffer, live.streamOpenTs, script, conductor, refresh]);

  const scrubPct = useMemo(() => {
    const total = totalAnimationDurationMs(snapshot.schedule);
    if (total <= 0) return 0;
    return Math.round((snapshot.animationMs / total) * 100);
  }, [snapshot.animationMs, snapshot.schedule]);

  const handleScrub = (pct: number) => {
    const total = totalAnimationDurationMs(snapshot.schedule);
    conductor.scrubToAnimationMs((pct / 100) * total);
    refresh();
  };

  const handleSaveBookmark = () => {
    if (!from || !to) return;
    const next = addBookmark({
      from,
      to,
      label: `${from.slice(0, 16)}…`,
      conversationId: filterConversation || undefined,
      agentId: filterAgent || undefined,
      eventKind: filterKind || undefined,
    });
    setBookmarks(next);
  };

  if (authed === null) {
    return <div className="shell">Checking session…</div>;
  }

  if (!authed) {
    return (
      <div className="shell">
        <h1>Ant Farm</h1>
        <p>Sign in via the main console first (session cookie required).</p>
        <a href="/">Open console</a>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="header">
        <h1>Ant Farm</h1>
        <p className="subtitle">DVR for the office — replay and live monitoring</p>
      </header>

      <div className="window-controls">
        <label>
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadWindow(from, to, filterConversation || undefined)}
        >
          {loading ? 'Loading…' : 'Load window'}
        </button>
        {error && <span className="error">{error}</span>}
      </div>

      <TransportBar
        mode={snapshot.mode}
        velocity={snapshot.velocity}
        onPlay={() => { conductor.setMode('playing'); refresh(); }}
        onPause={() => { conductor.setMode('paused'); refresh(); }}
        onLive={() => {
          setLiveMode(true);
          conductor.setMode('live');
          refresh();
        }}
        onVelocityChange={(v) => { conductor.setVelocity(v); refresh(); }}
        onScrub={handleScrub}
        scrubPct={scrubPct}
        filterConversation={filterConversation}
        filterAgent={filterAgent}
        filterKind={filterKind}
        onFilterConversation={setFilterConversation}
        onFilterAgent={setFilterAgent}
        onFilterKind={setFilterKind}
      />

      <div className="main">
        <OfficeView
          desks={desks}
          activeDirective={activeDirective}
          firedCount={snapshot.firedIndex + 1}
        />
        <BookmarkPanel
          bookmarks={bookmarks}
          onSave={handleSaveBookmark}
          onLoad={(b) => {
            setFrom(b.from.slice(0, 16));
            setTo(b.to.slice(0, 16));
            setFilterConversation(b.conversationId ?? '');
            setFilterAgent(b.agentId ?? '');
            setFilterKind(b.eventKind ?? '');
            void loadWindow(b.from, b.to, b.conversationId);
          }}
          onRemove={(index) => setBookmarks(removeBookmark(index))}
        />
      </div>
    </div>
  );
}
