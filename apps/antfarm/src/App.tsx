import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityScript, SceneDirective } from '@curia/shared-types';
import { apiFetch, checkSession } from './api.js';
import { clientWarn } from './client-log.js';
import { PhaserOffice } from './game/PhaserOffice.js';
import { DetailOverlay, type OverlayDetail } from './components/DetailOverlay.js';
import { CreditsFooter } from './components/CreditsFooter.js';
import { TransportBar } from './components/TransportBar.js';
import { BookmarkPanel } from './components/BookmarkPanel.js';
import { useTimeline } from './hooks/useTimeline.js';
import { useLiveStream } from './hooks/useLiveStream.js';
import { useConductor } from './hooks/useConductor.js';
import type { PlaybackMode } from './conductor/types.js';
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
      if (d.kind === 'tube.in' || d.kind === 'tube.out') {
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
  const [overlayDetail, setOverlayDetail] = useState<OverlayDetail | null>(null);
  const savedModeRef = useRef<PlaybackMode>('paused');
  const mergedLiveCountRef = useRef(0);
  const lastScriptRef = useRef<ActivityScript | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterConversation, setFilterConversation] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterKind, setFilterKind] = useState('');

  const { script, loading, error, fetchTimeline } = useTimeline();
  const live = useLiveStream(liveMode);
  const { snapshot, conductor, refresh } = useConductor();

  useEffect(() => {
    void checkSession()
      .then(setAuthed)
      .catch((err) => {
        clientWarn('session check failed', err);
        setAuthed(false);
      });
    void apiFetch('/api/registry/agents')
      .then((res) => res.ok ? res.json() : { agents: [] })
      .then((data: { agents?: RegistryAgent[] }) => setRegistryAgents(data.agents ?? []))
      .catch((err) => {
        clientWarn('failed to load registry agents', err);
        setRegistryAgents([]);
      });
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

  const openOverlay = useCallback((detail: OverlayDetail) => {
    const mode = conductor.getMode();
    if (mode === 'playing' || mode === 'live') {
      savedModeRef.current = mode;
      conductor.setMode('paused');
      refresh();
    }
    setOverlayDetail(detail);
  }, [conductor, refresh]);

  const closeOverlay = useCallback(() => {
    setOverlayDetail(null);
    const restore = savedModeRef.current;
    if (restore === 'playing' || restore === 'live') {
      conductor.setMode(restore);
      refresh();
    }
    savedModeRef.current = 'paused';
  }, [conductor, refresh]);

  const loadWindow = useCallback(async (windowFrom: string, windowTo: string, conv?: string) => {
    mergedLiveCountRef.current = 0;
    if (liveMode && live.streamOpenTs !== null) {
      await fetchTimeline({
        from: windowFrom || undefined,
        to: new Date(live.streamOpenTs).toISOString(),
        conversationId: conv,
      });
    } else {
      await fetchTimeline({
        from: windowFrom || undefined,
        to: windowTo || undefined,
        conversationId: conv,
      });
    }
  }, [fetchTimeline, live.streamOpenTs, liveMode]);

  // Single source of truth: sync conductor when timeline script changes.
  useEffect(() => {
    if (!script) return;

    if (script !== lastScriptRef.current) {
      mergedLiveCountRef.current = 0;
      lastScriptRef.current = script;
    }

    if (liveMode && live.streamOpenTs !== null) {
      if (live.buffer.length === 0) {
        conductor.loadScript(script);
      } else if (mergedLiveCountRef.current === 0) {
        conductor.mergeLiveBuffer(script.directives, live.buffer, live.streamOpenTs);
        mergedLiveCountRef.current = live.buffer.length;
      } else if (live.buffer.length > mergedLiveCountRef.current) {
        const newSlice = live.buffer.slice(mergedLiveCountRef.current);
        conductor.appendDirectives(newSlice);
        mergedLiveCountRef.current = live.buffer.length;
      }
    } else if (!liveMode) {
      conductor.loadScript(script);
    }
    refresh();
  }, [script, liveMode, live.buffer, live.streamOpenTs, conductor, refresh]);

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
          mergedLiveCountRef.current = 0;
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
        <div className="stage-column">
          <PhaserOffice
            desks={desks}
            schedule={snapshot.schedule}
            firedIndex={snapshot.firedIndex}
            onAgentClick={(agentId, directive) => {
              openOverlay({ type: 'agent', agentId, directive });
            }}
            onDirectiveClick={(directive) => {
              openOverlay({ type: 'directive', directive });
            }}
          />
          <div className="office-meta">
            <span>{snapshot.firedIndex + 1} beats played</span>
            {snapshot.schedule[snapshot.firedIndex]?.directive && (
              <span className="active-beat">
                {snapshot.schedule[snapshot.firedIndex]!.directive.kind}
              </span>
            )}
          </div>
          <CreditsFooter />
        </div>
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

      <DetailOverlay detail={overlayDetail} onClose={closeOverlay} />
    </div>
  );
}
