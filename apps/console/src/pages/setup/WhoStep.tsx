import { useState, type FormEvent, type JSX } from 'react';
import { detectBrowserTimezone, validatePrincipalName, validateProfileEmail } from '../wizard-utils.js';
import { postJson, saveSetupFields, type PrincipalInfo, type SetupFields, type SetupFor } from './setup-api.js';
import { ChoiceGroup, StepFooter } from './setup-ui.js';

// IANA zones for the timezone picker; a short fallback list where the browser can't list them.
const IANA_ZONES: string[] = typeof (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf === 'function'
  ? (Intl as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone')
  : ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
     'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney', 'UTC'];

interface Props {
  fields: SetupFields;
  principal: PrincipalInfo | null;
  onSaved: () => Promise<void>;
  onContinue: () => void;
  /** Opens the setup guide (PR 4); the link is hidden until then. */
  onHelp?: () => void;
}

/** Step 1 (#2358): who Curia is for, the operator when that's someone else, and the principal. */
export function WhoStep({ fields, principal, onSaved, onContinue, onHelp }: Props): JSX.Element {
  const [setupFor, setSetupFor] = useState<SetupFor | null>(fields.setupFor);
  const [operatorName, setOperatorName] = useState(fields.operatorName ?? '');
  const [operatorEmail, setOperatorEmail] = useState(fields.operatorEmail ?? '');
  const [name, setName] = useState(principal?.displayName ?? '');
  const [title, setTitle] = useState(principal?.title ?? '');
  const [email, setEmail] = useState(principal?.email ?? '');
  const [timezone, setTimezone] = useState(principal?.timezone ?? detectBrowserTimezone());
  const [pronouns, setPronouns] = useState(principal?.pronouns ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function validate(): string | null {
    if (!setupFor) return 'Choose who you’re setting Curia up for.';
    if (setupFor === 'other') {
      if (!operatorName.trim()) return 'Add your name.';
      if (!operatorEmail.trim()) return 'Add your email.';
      const opEmail = validateProfileEmail(operatorEmail);
      if (opEmail) return opEmail;
    }
    const nameError = validatePrincipalName(name);
    if (nameError) return setupFor === 'other' ? nameError.replace('Your name', 'Their name') : nameError;
    if (!email.trim()) return setupFor === 'other' ? 'Add their email.' : 'Add your email.';
    return validateProfileEmail(email) ?? (timezone.trim() ? null : 'Choose a timezone.');
  }

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      // The Setup row first: it marks Setup in progress, so the page stays the landing page.
      await saveSetupFields({
        setupFor,
        operatorName: setupFor === 'other' ? operatorName.trim() : null,
        operatorEmail: setupFor === 'other' ? operatorEmail.trim() : null,
      });
      await postJson('/api/setup/principal', { name: name.trim() });
      await postJson('/api/setup/principal/profile', {
        timezone: timezone.trim(),
        email: email.trim(),
        // Always sent: a blank clears the stored value.
        title: title.trim() || null,
        pronouns: pronouns.trim() || null,
      });
      await onSaved();
      onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const other = setupFor === 'other';
  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <h2>Who are you setting Curia up for?</h2>
      <p className="setup-lede">This decides how Curia talks to you during setup and who it greets when it’s done.</p>
      <ChoiceGroup
        label="Who Curia is for"
        value={setupFor}
        onChange={setSetupFor}
        options={[
          { value: 'self', title: 'Myself', description: 'You’ll set it up, then go straight into your first conversation.' },
          { value: 'other', title: 'Someone else', description: 'An executive you work for. You set things up; they get an invitation when you’re ready.' },
        ]}
      />

      {other && (
        <>
          <div className="setup-section">
            <span className="setup-section-label">About you</span>
            <span className="setup-hint">Curia treats you as its operator: the person who looks after setup and admin. Later, it will bring admin and support questions to you rather than to the person it works for.</span>
          </div>
          <div className="setup-fields">
            <div className="setup-row2">
              <label className="setup-field">Your name
                <input type="text" value={operatorName} onChange={(e) => setOperatorName(e.target.value)} autoComplete="name" />
              </label>
              <label className="setup-field">Your email
                <input type="email" value={operatorEmail} onChange={(e) => setOperatorEmail(e.target.value)} autoComplete="email" />
              </label>
            </div>
          </div>
        </>
      )}

      {setupFor && (
        <>
          <div className="setup-section">
            <span className="setup-section-label">{other ? 'Who Curia will work for' : 'About you'}</span>
            {other && <span className="setup-hint">They can correct any of these later.</span>}
          </div>
          <div className="setup-fields">
            <div className="setup-row2">
              <label className="setup-field">Full name
                <input id="setup-principal-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="setup-field">Title <span className="setup-hint">(optional)</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
            </div>
            <label className="setup-field">Email
              <input id="setup-principal-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <div className="setup-row2">
              <label className="setup-field">Timezone
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {!IANA_ZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
                  {IANA_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </label>
              <label className="setup-field">Pronouns <span className="setup-hint">(optional)</span>
                <input type="text" value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="she/her" />
              </label>
            </div>
          </div>
        </>
      )}

      {error && <p className="setup-status attention" role="alert">{error}</p>}
      <StepFooter primary={saving ? 'Saving…' : 'Save and continue'} primaryDisabled={saving} onHelp={onHelp} submit />
    </form>
  );
}
