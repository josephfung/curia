import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityScript, SceneDirective } from '@curia/shared-types';
import { apiFetch, checkSession } from './api.js';
import { clientWarn } from './client-log.js';
import { PhaserOffice } from './game/PhaserOffice.js';
import { DetailOverlay, type OverlayDetail } from './components/DetailOverlay.js';
import { CreditsFooter } from './components/CreditsFooter.js';
import { TransportBar } from './components/TransportBar.js';
import { useTimeline } from './hooks/useTimeline.js';
import { useLiveStream } from './hooks/useLiveStream.js';
import { useConductor } from './hooks/useConductor.js';
import type { PlaybackMode } from './conductor/types.js';
import {
  agentIdsFromDirectives,
  agentRosterKey,
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

/** Format a Date as a datetime-local input value (local wall-clock, 'YYYY-MM-DDTHH:mm'). */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [registryAgents, setRegistryAgents] = useState<RegistryAgent[]>([]);
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

  const rosterKey = useMemo(
    () => agentRosterKey(registryAgents, agentIdsFromDirectives(filteredDirectives)),
    [registryAgents, filteredDirectives],
  );

  const desks = useMemo(() => {
    const directiveIds = agentIdsFromDirectives(filteredDirectives);
    let layout = buildDeskLayout(registryAgents, directiveIds);
    for (const id of directiveIds) {
      layout = ensureAgentDesk(layout, id);
    }
    return layout;
  // rosterKey captures registry + directive agent set; avoid deps that churn each frame.
  }, [registryAgents, rosterKey]);

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

  // Preload the last-24h window on arrival so the page lands ready to play (just hit Play).
  // Runs once after auth succeeds. The input fields get local wall-clock strings for display;
  // the fetch uses ISO timestamps so the server parses absolute instants regardless of its tz.
  const didPreload = useRef(false);
  useEffect(() => {
    if (authed !== true || didPreload.current) return;
    didPreload.current = true;
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    setFrom(toDatetimeLocal(start));
    setTo(toDatetimeLocal(now));
    // fetchTimeline already surfaces failures via `error` (shown in the control bar); catch here
    // so the rejection isn't unhandled. Intentionally do NOT reset didPreload — a failed preload
    // shows the error and waits for a manual "Load window" rather than auto-retrying every render.
    loadWindow(start.toISOString(), now.toISOString()).catch((err) => {
      clientWarn('24h preload failed; error shown in control bar', err);
    });
  }, [authed, loadWindow]);

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
        from={from}
        to={to}
        loading={loading}
        error={error}
        onFrom={setFrom}
        onTo={setTo}
        onLoadWindow={() => void loadWindow(from, to, filterConversation || undefined)}
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
      </div>

      <DetailOverlay detail={overlayDetail} onClose={closeOverlay} />
    </div>
  );
}
