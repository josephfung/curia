// The setup guide panel (#2358, PR 4): the setup agent as a help panel docked to the right
// of the Setup page. It is the console's own chat (ChatThread, ChatComposer, useChatSession
// over /api/chat/*), with the open step sent on each message. It never drives Setup.
import { useEffect, useRef, useState, type JSX } from 'react';
import { ChatComposer } from '../chat/ChatComposer.js';
import { ChatThread } from '../chat/ChatThread.js';
import { useChatSession } from '../chat/useChatSession.js';
import type { Message } from '../chat/types.js';
import type { StepId } from './setup-steps.js';

/** A "Now on: <step>" line, placed after the message that was last when the step changed. */
export interface StepMarker {
  id: string;
  text: string;
  /** The message it follows; null for before any message. */
  afterId: string | null;
}

/**
 * The thread with the step markers in place. Markers live only in the panel (the server's
 * history has none), so each is pinned to the message it followed; one whose message is no
 * longer loaded goes at the top of what is.
 */
export function withStepMarkers(messages: readonly Message[], markers: readonly StepMarker[]): Message[] {
  const asMessage = (m: StepMarker): Message => ({ id: m.id, kind: 'status', text: m.text });
  const ids = new Set(messages.map((m) => m.id));
  const out: Message[] = markers.filter((m) => m.afterId === null || !ids.has(m.afterId)).map(asMessage);
  for (const msg of messages) {
    out.push(msg);
    for (const m of markers) if (m.afterId === msg.id) out.push(asMessage(m));
  }
  return out;
}

/**
 * The guide's opening line on a thread with no history, so the panel doesn't open blank. It
 * lives in the panel only: never saved, never sent to the model.
 */
export const SETUP_GUIDE_GREETING: Message = {
  id: 'setup-guide-greeting',
  kind: 'agent',
  text: 'As you go through Setup, ask me anything: what a step is for, where to find a key, or which option to pick.',
};

export function SetupGuidePanel(props: {
  /** Closed: kept mounted (its thread, markers and draft survive) but not shown. */
  hidden: boolean;
  step: StepId;
  stepName: string;
  /** Text the "Need help?" link puts in the composer. */
  draft?: { text: string; seq: number };
  /** Why messages may not reach the setup guide (starting Setup failed, or can't here). */
  notice?: string | null;
  onClose: () => void;
  /** Shown below about 1,180px wide, where the step list hides while the panel is open. */
  onShowSteps: () => void;
}): JSX.Element {
  const { step, stepName } = props;
  const { messages, sending, hasMore, loadingHistory, connectionError, send, loadMore } = useChatSession({ setupStep: step });
  const [markers, setMarkers] = useState<StepMarker[]>([]);
  const lastStep = useRef(step);
  const lastMessageId = useRef<string | null>(null);
  lastMessageId.current = messages.at(-1)?.id ?? null;
  const asideRef = useRef<HTMLElement>(null);
  // A reply that arrived while closed was scrolled to in a hidden thread, which does nothing:
  // bring the newest message into view each time the panel opens again.
  useEffect(() => {
    if (props.hidden) return;
    const thread = asideRef.current?.querySelector<HTMLElement>('.chat-messages');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [props.hidden]);
  const historyPending = useRef(true);
  historyPending.current = loadingHistory && messages.length === 0;
  // Greet once the history has loaded empty, and keep the greeting at the top after the
  // first message, so it doesn't vanish mid-conversation.
  const [greet, setGreet] = useState(false);
  useEffect(() => {
    if (!loadingHistory && messages.length === 0 && !hasMore) setGreet(true);
  }, [loadingHistory, messages.length, hasMore]);

  // A marker each time the open step changes. None before the history has loaded: it would
  // sit above messages it came after.
  useEffect(() => {
    if (step === lastStep.current) return;
    lastStep.current = step;
    if (historyPending.current) return;
    setMarkers((prev) => [...prev, { id: `step-${prev.length}-${step}`, text: `Now on: ${stepName}`, afterId: lastMessageId.current }]);
  }, [step, stepName]);

  return (
    <aside
      ref={asideRef}
      className="setup-guide"
      aria-label="Setup guide"
      hidden={props.hidden}
      onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}
    >
      <div className="setup-guide-head">
        <div>
          <b>Setup guide</b>
          <span>Curia’s here to help you through Setup.</span>
        </div>
        <button type="button" className="setup-guide-steps" onClick={props.onShowSteps}>Steps</button>
        <button type="button" className="setup-guide-close" aria-label="Close setup guide" onClick={props.onClose}>×</button>
      </div>
      {props.notice && <div className="chat-connection" role="alert">{props.notice}</div>}
      {connectionError && <div className="chat-connection" role="status">{connectionError}</div>}
      <ChatThread messages={[...(greet ? [SETUP_GUIDE_GREETING] : []), ...withStepMarkers(messages, markers)]} hasMore={hasMore} loadingHistory={loadingHistory} loadMore={loadMore} />
      <ChatComposer disabled={sending} onSend={(text) => void send(text)} draft={props.draft} />
    </aside>
  );
}
