import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import {
  assistantFullName,
  defaultSignature,
  DEFAULT_ASSISTANT_FIRST_NAME,
  validateNonEmptyName,
  type LocalIdentity,
} from '../wizard-utils.js';
import { StepFooter } from './setup-ui.js';

interface Props {
  principalName: string | null;
  onSaved: () => Promise<void>;
  onContinue: () => void;
  onHelp?: () => void;
}

interface IdentityResponse {
  identity: LocalIdentity;
  configured: boolean;
}

/**
 * Step 2 (#2358): Curia's name, title and signature. The save re-reads the identity and
 * changes only the assistant block, so tone and preferences set elsewhere are kept.
 */
export function CuriaNameStep({ principalName, onSaved, onContinue, onHelp }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [signature, setSignature] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/identity');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as IdentityResponse;
        let first = DEFAULT_ASSISTANT_FIRST_NAME;
        // A first visit on a new install: offer a suggested first name (#799). Best effort:
        // any failure keeps the default.
        if (!data.configured) {
          try {
            const s = await apiFetch('/api/setup/suggest-name', { method: 'POST' });
            if (s.ok) {
              const suggested = (await s.json() as { name?: unknown }).name;
              if (typeof suggested === 'string' && suggested.trim()) first = suggested.trim();
            }
          } catch (err) {
            console.error('[CuriaNameStep] name suggestion failed; keeping the default:', err);
          }
        }
        if (cancelled) return;
        const a = data.identity.assistant;
        setName(data.configured ? a.name : assistantFullName(first));
        setTitle(data.configured ? a.title : principalName ? `Executive Assistant to ${principalName}` : a.title);
        setSignature(data.configured ? a.emailSignature : defaultSignature(first));
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load Curia’s name.');
      }
    })();
    return () => { cancelled = true; };
    // principalName only seeds the title on the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!validateNonEmptyName(name)) { setError('Curia needs a name.'); return; }
    setSaving(true);
    setError(null);
    try {
      const current = await apiFetch('/api/identity');
      if (!current.ok) throw new Error(await errorMessage(current));
      const existing = (await current.json() as IdentityResponse).identity;
      const identity: LocalIdentity = {
        ...existing,
        assistant: { name: name.trim(), title: title.trim(), emailSignature: signature.trim() },
      };
      const put = await apiFetch('/api/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, changedBy: 'wizard', note: 'Saved from the Setup page' }),
      });
      if (!put.ok) throw new Error(await errorMessage(put));
      const reload = await apiFetch('/api/identity/reload', { method: 'POST' });
      // The PUT already made the new identity live (OfficeIdentityService.update sets it in
      // memory before the response); the reload only re-reads it. A failed reload is reported
      // as just that, never as a failed save.
      await onSaved();
      if (!reload.ok) {
        setError(`Saved, and Curia is using it. The follow-up reload failed: ${await errorMessage(reload)}`);
        return;
      }
      onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <h2>What should Curia be called?</h2>
      <p className="setup-lede">Used in emails and messages Curia sends.</p>
      <div className="setup-fields">
        <label className="setup-field">Name
          <input id="setup-curia-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={!loaded} />
        </label>
        <label className="setup-field">Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!loaded} />
        </label>
        <label className="setup-field"><span className="setup-field-label">Email signature <span className="setup-hint">(optional)</span></span>
          <textarea value={signature} onChange={(e) => setSignature(e.target.value)} rows={3} disabled={!loaded} />
        </label>
      </div>
      {error && <p className="setup-status attention" role="alert">{error}</p>}
      <StepFooter primary={saving ? 'Saving…' : 'Save and continue'} primaryDisabled={saving || !loaded} onHelp={onHelp} submit />
    </form>
  );
}
