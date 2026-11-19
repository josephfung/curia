// The Setup page (#2358): the console's landing page on a new install until Start
// onboarding. A step list on the left, the open step's form in the middle, and the setup
// guide's chat docked on the right when open. Each step can be opened directly; Save and
// continue walks them in order. Step status comes from the Setup checklist the setup agent
// also reads (GET /api/setup/checklist).
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  EMPTY_SETUP_FIELDS,
  fetchChecklist,
  fetchPrincipal,
  fetchSetupFields,
  startSetup,
  type PrincipalInfo,
  type SetupFields,
} from './setup-api.js';
import {
  EXTRAS,
  firstName,
  firstOpenStep,
  groupLabel,
  isExtra,
  isFirstRun,
  nextStep,
  principalLabel,
  stepMark,
  STEPS,
  type Checklist,
  type StepId,
} from './setup-steps.js';
import { WhoStep } from './WhoStep.js';
import { CuriaNameStep } from './CuriaNameStep.js';
import { EmailStep, MessagingStep, SignInStep, VoiceStep } from './ChannelSteps.js';
import { ApplyStep, StartStep } from './FinishSteps.js';
import { CapabilitiesStep, GoogleWorkspaceStep, WebSearchStep, WorkingStyleStep } from './ExtraSteps.js';
import { SetupGuidePanel } from './SetupGuidePanel.js';

const PHONE_QUERY = '(max-width: 760px)';

/** A phone: the guide is full-screen there, so it doesn't open by itself. */
function isPhoneWidth(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(PHONE_QUERY).matches;
}

/** isPhoneWidth, kept current as the window resizes. */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(isPhoneWidth);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = (): void => setPhone(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}

interface Loaded {
  checklist: Checklist;
  fields: SetupFields;
  principal: PrincipalInfo;
}

export default function SetupPage(): JSX.Element {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { step?: StepId };
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest load may set state: a slow response must not overwrite a newer one.
  const loadSeq = useRef(0);

  // Opening the Setup page starts Setup (POST /api/setup/start), so web chat goes to the
  // setup guide from the first message, before anything is saved. Until it does, the guide
  // says so; a failed call is retried with each refresh (any save, or a step's check).
  const [guideNotice, setGuideNotice] = useState<string | null>(null);
  const guideReady = useRef(false);
  // One start at a time: a mount call and a refresh call overlapping must not let the older
  // one's failure land after the newer one's success.
  const starting = useRef<Promise<void> | null>(null);
  const ensureGuide = useCallback(async (): Promise<void> => {
    if (guideReady.current) return;
    if (starting.current) return starting.current;
    starting.current = startOnce().finally(() => { starting.current = null; });
    return starting.current;
  }, []);
  async function startOnce(): Promise<void> {
    try {
      const { setupGuide } = await startSetup();
      guideReady.current = setupGuide;
      setGuideNotice(setupGuide ? null
        : 'This install was set up outside the Setup page, so messages here go to Curia’s usual chat, not the setup guide.');
    } catch (err) {
      console.error('[SetupPage] could not start Setup:', err);
      setGuideNotice(`Couldn’t start Setup (${err instanceof Error ? err.message : 'unknown error'}), so messages here may reach Curia’s usual chat instead of the setup guide.`);
    }
  }

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const [checklist, fields, principal] = await Promise.all([fetchChecklist(), fetchSetupFields(), fetchPrincipal()]);
      if (seq !== loadSeq.current) return;
      setData({ checklist, fields, principal });
      setLoadError(null);
      void ensureGuide();
    } catch (err) {
      if (seq !== loadSeq.current) return;
      console.error('[SetupPage] failed to load the Setup checklist:', err);
      setLoadError(err instanceof Error ? err.message : 'Could not load Setup.');
    }
  }, [ensureGuide]);

  useEffect(() => { void ensureGuide(); }, [ensureGuide]);
  useEffect(() => { void refresh(); }, [refresh]);

  // The guide: open by itself on a first run (not on a phone), closed when an operator comes
  // back to Setup. Decided once, on the first load. Once opened it stays mounted, hidden when
  // closed, so its thread, step markers and anything half-typed survive a close.
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideMounted, setGuideMounted] = useState(false);
  useEffect(() => { if (guideOpen) setGuideMounted(true); }, [guideOpen]);
  const phone = usePhoneWidth();
  const stepsRef = useRef<HTMLElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  // Closing the guide unmounts nothing but hides the focused element: move focus to the open
  // step's heading, or (Steps, below 1180px) to the open step in the list.
  function closeGuide(focus: 'step' | 'steps'): void {
    setGuideOpen(false);
    requestAnimationFrame(() => {
      const target = focus === 'steps'
        ? stepsRef.current?.querySelector<HTMLElement>('[aria-current="step"]')
        : paneRef.current?.querySelector<HTMLElement>('h2');
      if (target && focus === 'step') target.tabIndex = -1;
      target?.focus();
    });
  }
  const guideDecided = useRef(false);
  const [draft, setDraft] = useState<{ text: string; seq: number } | undefined>(undefined);
  useEffect(() => {
    if (!data || guideDecided.current) return;
    guideDecided.current = true;
    if (isFirstRun(data.checklist, data.fields) && !isPhoneWidth()) setGuideOpen(true);
  }, [data]);

  // Without ?step, land on the first open step once, and pin it in the URL: a later refresh
  // (a step saved, or a check changing) must not move the operator to another step.
  useEffect(() => {
    if (!search.step && data) void navigate({ to: '/setup', search: { step: firstOpenStep(data.checklist) }, replace: true });
  }, [search.step, data, navigate]);

  const current: StepId = search.step ?? firstOpenStep(data?.checklist ?? null);
  const goTo = useCallback((step: StepId) => {
    void navigate({ to: '/setup', search: { step } });
  }, [navigate]);
  const goNext = useCallback(() => {
    const next = nextStep(current);
    if (next) goTo(next);
  }, [current, goTo]);

  const checklist = data?.checklist ?? null;
  const fields = data?.fields ?? EMPTY_SETUP_FIELDS;
  const principal = principalLabel(data?.principal.displayName);
  const principalFirst = firstName(data?.principal.displayName);
  const required = STEPS.filter((s) => s.id !== 'apply' && s.id !== 'start');
  const doneCount = required.filter((s) => stepMark(s.id, checklist) === 'done').length;
  const taskFor = (id: string) => checklist?.tasks.find((t) => t.id === id);
  const index = STEPS.findIndex((s) => s.id === current);
  const step = [...STEPS, ...EXTRAS].find((s) => s.id === current)!;
  // "Need help?" opens the guide with the step named in the composer. While the guide is
  // open the link is hidden: the guide already follows the open step.
  const help = guideOpen ? undefined : (): void => {
    setDraft((d) => ({ text: `I’m on the ${step.name} step. `, seq: (d?.seq ?? 0) + 1 }));
    setGuideOpen(true);
  };

  function renderStep(): JSX.Element {
    if (!data) return <p className="setup-lede">{loadError ?? 'Loading…'}</p>;
    switch (current) {
      case 'who':
        return <WhoStep key="who" fields={data.fields} principal={data.principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'curia_name':
        return <CuriaNameStep key="curia_name" principalName={data.principal.displayName} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'email':
        return <EmailStep task={taskFor('email')} principal={principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'messaging':
        return <MessagingStep key="messaging" task={taskFor('messaging')} principal={principal} fields={fields} contactId={data.principal.contactId} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'voice':
        return <VoiceStep key="voice" task={taskFor('voice')} principal={principal} fields={fields} contactId={data.principal.contactId} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'mailbox_signin':
        return <SignInStep task={taskFor('mailbox_signin')} principal={principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'apply':
        return <ApplyStep checklist={checklist} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'start':
        return <StartStep checklist={checklist} principal={principal} onRefresh={refresh} onHelp={help} />;
      case 'working_style':
        return <WorkingStyleStep key="working_style" task={taskFor('working_style')} principal={principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'google_workspace':
        return <GoogleWorkspaceStep key="google_workspace" task={taskFor('google_workspace')} principal={principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'web_research':
        return <WebSearchStep key="web_research" task={taskFor('web_research')} principal={principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
      case 'capabilities':
        return <CapabilitiesStep key="capabilities" task={taskFor('capabilities')} principal={principal} onSaved={refresh} onContinue={goNext} onHelp={help} />;
    }
  }

  let lastGroup: string | null = null;
  return (
    <div className={`setup-page${guideOpen ? ' guide-open' : ''}`}>
      {/* On a phone the open guide covers the page: what is behind it leaves the tab order. */}
      <nav className="setup-steps" aria-label="Setup steps" ref={stepsRef} inert={guideOpen && phone}>
        <h1>Set up Curia</h1>
        <p className="setup-count">{data ? `${doneCount} of ${required.length} required steps done` : ' '}</p>
        {[...STEPS, ...EXTRAS].map((s) => {
          const label = groupLabel(s.group, principalFirst);
          const heading = label !== lastGroup ? <div className="setup-group" key={`g-${s.group}`}>{label}</div> : null;
          lastGroup = label;
          const mark = stepMark(s.id, checklist);
          return (
            <div key={s.id}>
              {heading}
              <button
                type="button"
                className={`setup-step ${mark}`}
                aria-current={s.id === current ? 'step' : undefined}
                onClick={() => goTo(s.id)}
              >
                <span className="setup-dot" aria-hidden="true">{mark === 'done' ? '✓' : ''}</span>
                {s.name}
                <span className="sr-only">{mark === 'done' ? ' (done)' : mark === 'attention' ? ' (needs a restart)' : mark === 'locked' ? ' (locked)' : ''}</span>
              </button>
            </div>
          );
        })}
      </nav>
      <section className="setup-pane" aria-live="polite" ref={paneRef} inert={guideOpen && phone}>
        <div className="setup-eyebrow">
          {isExtra(current) ? 'Optional extra' : `Step ${index + 1} of ${STEPS.length} · ${groupLabel(step.group, principalFirst)}`}
        </div>
        {loadError && data && <p className="setup-status attention" role="alert">{loadError}</p>}
        {renderStep()}
      </section>
      {guideMounted && (
        <SetupGuidePanel
          hidden={!guideOpen}
          step={current}
          stepName={step.name}
          draft={draft}
          notice={guideNotice}
          onClose={() => closeGuide('step')}
          onShowSteps={() => closeGuide('steps')}
        />
      )}
    </div>
  );
}
