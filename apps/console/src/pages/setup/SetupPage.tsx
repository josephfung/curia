// The Setup page (#2358): the console's landing page on a new install until Start
// onboarding. A step list on the left, the open step's form on the right. Each step can be
// opened directly; Save and continue walks them in order. Step status comes from the Setup
// checklist the setup agent also reads (GET /api/setup/checklist).
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  EMPTY_SETUP_FIELDS,
  fetchChecklist,
  fetchPrincipal,
  fetchSetupFields,
  type PrincipalInfo,
  type SetupFields,
} from './setup-api.js';
import {
  EXTRAS,
  firstName,
  firstOpenStep,
  groupLabel,
  isExtra,
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
import { GoogleWorkspaceStep, WebSearchStep, WorkingStyleStep } from './ExtraSteps.js';

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

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const [checklist, fields, principal] = await Promise.all([fetchChecklist(), fetchSetupFields(), fetchPrincipal()]);
      if (seq !== loadSeq.current) return;
      setData({ checklist, fields, principal });
      setLoadError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      console.error('[SetupPage] failed to load the Setup checklist:', err);
      setLoadError(err instanceof Error ? err.message : 'Could not load Setup.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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

  function renderStep(): JSX.Element {
    if (!data) return <p className="setup-lede">{loadError ?? 'Loading…'}</p>;
    switch (current) {
      case 'who':
        return <WhoStep key="who" fields={data.fields} principal={data.principal} onSaved={refresh} onContinue={goNext} />;
      case 'curia_name':
        return <CuriaNameStep key="curia_name" principalName={data.principal.displayName} onSaved={refresh} onContinue={goNext} />;
      case 'email':
        return <EmailStep task={taskFor('email')} principal={principal} onSaved={refresh} onContinue={goNext} />;
      case 'messaging':
        return <MessagingStep key="messaging" task={taskFor('messaging')} principal={principal} fields={fields} contactId={data.principal.contactId} onSaved={refresh} onContinue={goNext} />;
      case 'voice':
        return <VoiceStep key="voice" task={taskFor('voice')} principal={principal} fields={fields} contactId={data.principal.contactId} onSaved={refresh} onContinue={goNext} />;
      case 'mailbox_signin':
        return <SignInStep task={taskFor('mailbox_signin')} principal={principal} onSaved={refresh} onContinue={goNext} />;
      case 'apply':
        return <ApplyStep checklist={checklist} onSaved={refresh} onContinue={goNext} />;
      case 'start':
        return <StartStep checklist={checklist} principal={principal} onRefresh={refresh} />;
      case 'working_style':
        return <WorkingStyleStep key="working_style" task={taskFor('working_style')} principal={principal} onSaved={refresh} onContinue={goNext} />;
      case 'google_workspace':
        return <GoogleWorkspaceStep key="google_workspace" task={taskFor('google_workspace')} principal={principal} onSaved={refresh} onContinue={goNext} />;
      case 'web_research':
        return <WebSearchStep key="web_research" task={taskFor('web_research')} principal={principal} onSaved={refresh} onContinue={goNext} />;
    }
  }

  let lastGroup: string | null = null;
  return (
    <div className="setup-page">
      <nav className="setup-steps" aria-label="Setup steps">
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
      <section className="setup-pane" aria-live="polite">
        <div className="setup-eyebrow">
          {isExtra(current) ? 'Optional extra' : `Step ${index + 1} of ${STEPS.length} · ${groupLabel(step.group, principalFirst)}`}
        </div>
        {loadError && data && <p className="setup-status attention" role="alert">{loadError}</p>}
        {renderStep()}
      </section>
    </div>
  );
}
