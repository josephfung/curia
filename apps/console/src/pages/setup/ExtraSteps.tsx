// The Setup page's optional extras (#2358, PR 3c): Working style, Google Workspace and the
// higher web search limit. None of them blocks Start onboarding.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { apiFetch } from '../../api.js';
import { bandForScore, type AutonomyBand } from '../../autonomy-bands.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import { STYLE_TEMPLATES, type LocalIdentity } from '../wizard-utils.js';
import { createLatestSaver, type ChecklistTask } from './setup-steps.js';
import { ChoiceGroup } from './setup-ui.js';
import { VaultKeysForm, type VaultFieldSpec } from './ChannelForms.js';
import { DOCS_ORIGIN, SaveAndContinue, useSaveAndContinue } from './ChannelSteps.js';

interface ExtraProps {
  task: ChecklistTask | undefined;
  principal: string;
  onSaved: () => Promise<void>;
  onContinue: () => void;
  onHelp?: () => void;
}

// The three levels the principal's first conversation offers (onboarding design §2.2), at
// the scores it sets. Full and Restricted stay in Settings → Autonomy.
type Independence = Extract<AutonomyBand, 'draft-only' | 'approval-required' | 'spot-check'>;
export const INDEPENDENCE_SCORES: Record<Independence, number> = {
  'draft-only': 65,
  'approval-required': 75,
  'spot-check': 85,
};

/** The Independence choice a stored score shows as; null for Full or Restricted. */
export function independenceFor(score: number): Independence | null {
  const band = bandForScore(score);
  return band in INDEPENDENCE_SCORES ? band as Independence : null;
}

/** The tone template a stored style is, or null for text written in Settings. */
export function toneFor(style: string): string | null {
  return STYLE_TEMPLATES.find((t) => t.text === style)?.id ?? null;
}

/** The "Sounds like" line a template ends with, for its card. */
function soundsLike(text: string): string {
  return text.split('\n').find((l) => l.startsWith('Sounds like:')) ?? '';
}

/**
 * A choice saved as soon as it is picked, newest last (createLatestSaver). A failed save
 * shows its error and the stored value again.
 */
function useSavedChoice<T extends string>(save: (value: T) => Promise<void>, reload: () => Promise<T | null>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestSave = useRef(save);
  latestSave.current = save;
  const saver = useRef(createLatestSaver((next: T) => latestSave.current(next))).current;
  const pending = useRef(0);

  const load = useCallback(async () => {
    try {
      setValue(await reload());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load.');
    }
    // reload is defined per render by the caller; load once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function pick(next: T): Promise<void> {
    setValue(next);
    setError(null);
    pending.current++;
    try {
      await saver(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      if (pending.current === 1) await load();
    } finally {
      pending.current--;
    }
  }
  return { value, error, pick };
}

async function readIdentity(): Promise<LocalIdentity> {
  const res = await apiFetch('/api/identity');
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json() as { identity: LocalIdentity }).identity;
}

async function readAutonomyScore(): Promise<number | null> {
  const res = await apiFetch('/api/autonomy');
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json() as { autonomy: { score: number } | null }).autonomy?.score ?? null;
}

export function WorkingStyleStep({ principal, onSaved, onContinue, onHelp }: ExtraProps): JSX.Element {
  const save = useSaveAndContinue(onContinue);
  const tone = useSavedChoice<string>(async (id) => {
    const template = STYLE_TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    // Re-read and change only the tone's style, so Curia's name and anything set elsewhere stay.
    const existing = await readIdentity();
    const put = await apiFetch('/api/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: { ...existing, tone: { ...existing.tone, style: template.text } },
        changedBy: 'wizard',
        note: 'Working style from the Setup page: a starting point for the principal',
      }),
    });
    if (!put.ok) throw new Error(await errorMessage(put));
    // The PUT already made it live; the reload only re-reads it, so its failure is logged.
    const reload = await apiFetch('/api/identity/reload', { method: 'POST' });
    if (!reload.ok) console.error('[WorkingStyleStep] identity reload after the tone save failed:', await errorMessage(reload));
    await onSaved();
  }, async () => toneFor((await readIdentity()).tone.style));

  const independence = useSavedChoice<Independence>(async (band) => {
    const res = await apiFetch('/api/autonomy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: INDEPENDENCE_SCORES[band],
        reason: 'Working style from the Setup page: a starting point for the principal',
      }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    await onSaved();
  }, async () => {
    const score = await readAutonomyScore();
    return score === null ? null : independenceFor(score);
  });

  return (
    <div>
      <h2>Working style</h2>
      <p className="setup-lede">
        Leave the defaults and {principal} chooses these in the first conversation. Anything you pick here is offered
        to {principal} there as a starting point, and saves as soon as you pick it.
      </p>
      <div className="setup-section">
        <span className="setup-section-label">Tone</span>
        <span className="setup-hint">How Curia sounds when it writes and speaks.</span>
      </div>
      <ChoiceGroup
        label="Tone"
        value={tone.value}
        onChange={(next) => void tone.pick(next)}
        options={STYLE_TEMPLATES.map((t) => ({
          value: t.id, title: t.label, description: soundsLike(t.text), tag: t.id === 'warm' ? 'Default' : undefined,
        }))}
      />
      {tone.error && <p className="setup-status attention" role="alert">{tone.error}</p>}
      <div className="setup-section">
        <span className="setup-section-label">Independence</span>
        <span className="setup-hint">How much Curia does before checking with {principal}.</span>
      </div>
      <ChoiceGroup
        label="Independence"
        value={independence.value}
        onChange={(next) => void independence.pick(next)}
        options={[
          { value: 'draft-only', title: 'Draft only', description: `Curia prepares drafts and summaries; ${principal} sends, schedules and commits.` },
          { value: 'approval-required', title: 'Ask first', description: `Curia carries out ${principal}’s instructions, and asks before acting on its own initiative.`, tag: 'Default' },
          { value: 'spot-check', title: 'Spot-check', description: `Curia goes ahead with most things and flags a few for ${principal} to review.` },
        ]}
      />
      {independence.error && <p className="setup-status attention" role="alert">{independence.error}</p>}
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}

const GOOGLE_FIELDS: readonly VaultFieldSpec[] = [
  { key: 'curia_google_email', label: 'Curia’s Google address', placeholder: 'curia@example.com', plain: true, email: true },
  { key: 'google_oauth_client_id', label: 'OAuth client ID', hint: 'from Google Cloud', plain: true },
  { key: 'google_oauth_client_secret', label: 'OAuth client secret' },
];

export function GoogleWorkspaceStep({ task, principal, onSaved, onContinue, onHelp }: ExtraProps): JSX.Element {
  const save = useSaveAndContinue(onContinue);
  return (
    <div>
      <h2>Google Workspace</h2>
      <p className="setup-lede">
        Lets Curia work in Google Docs, Sheets, Slides and Drive from its own Google account, and share files with {principal}.
      </p>
      <VaultKeysForm ref={save.register('google')} fields={GOOGLE_FIELDS} onChanged={onSaved} />
      <div className="setup-note">You can use the same Google Cloud project as {principal}’s email &amp; calendar.</div>
      <div className="setup-actions">
        {/* Signing in from the console is #2683; shown so the next step is visible. */}
        <button type="button" className="btn" disabled>Sign in as Curia (coming soon)</button>
        {task?.docs_url && (
          <a className="setup-link" href={`${DOCS_ORIGIN}${task.docs_url}`} target="_blank" rel="noopener noreferrer">Guide: Google Cloud setup</a>
        )}
      </div>
      <p className="setup-hint">Until then, the guide covers signing in as Curia.</p>
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}

const TAVILY_FIELDS: readonly VaultFieldSpec[] = [
  { key: 'tavily_api_key', label: 'Tavily API key', hint: 'starts with tvly-', placeholder: 'tvly-…' },
];

export function WebSearchStep({ task, onSaved, onContinue, onHelp }: ExtraProps): JSX.Element {
  const save = useSaveAndContinue(onContinue);
  const keyed = task?.optional_upgrade?.configured === true;
  return (
    <div>
      <h2>Higher web search limit</h2>
      <p className="setup-lede">
        Web search works without a key, but only a few dozen searches an hour. A free key
        from <a className="setup-link" href="https://tavily.com" target="_blank" rel="noopener noreferrer">Tavily</a> raises
        the limit.{' '}
        {task?.docs_url && (
          <a className="setup-link" href={`${DOCS_ORIGIN}${task.docs_url}`} target="_blank" rel="noopener noreferrer">Learn more about the limits</a>
        )}
      </p>
      <VaultKeysForm ref={save.register('tavily')} fields={TAVILY_FIELDS} onChanged={onSaved} />
      <p className="setup-hint">
        {keyed
          ? 'Curia’s web searches use this key.'
          : 'Without it, searches stop for a while when the hourly limit is reached.'}
      </p>
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}
