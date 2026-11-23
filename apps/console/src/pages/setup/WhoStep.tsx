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
  const [setupFor, setSetupFor] = useState<SetupFor>(fields.setupFor);
  const [operatorName, setOperatorName] = useState(fields.operatorName ?? '');
  const [operatorEmail, setOperatorEmail] = useState(fields.operatorEmail ?? '');
  const [name, setName] = useState(principal?.displayName ?? '');
  const [title, setTitle] = useState(principal?.title ?? '');
  const [email, setEmail] = useState(principal?.email ?? '');
  const [timezone, setTimezone] = useState(principal?.timezone ?? detectBrowserTimezone());
  const [pronouns, setPronouns] = useState(principal?.pronouns ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Set when the operator's confirmation notice could not go out yet. The step stays on one
   *  informational line rather than continuing silently: the notice is owed, not lost (#2710).
   *  Everything else on the step is already saved, so the second press only moves on. */
  const [notice, setNotice] = useState<{ message: string; name: string; email: string } | null>(null);

  /**
   * Any edit clears the owed-notice line and its "press again" state (#2710 review). The notice
   * is about the values that were saved; once one of them changes, pressing Save must save the
   * new values rather than continue with the old ones — otherwise an edit made after the first
   * press (a timezone, the principal's email, or a switch to "Myself") would be silently lost.
   */
  function edit<T>(setter: (value: T) => void): (value: T) => void {
    return (value: T) => {
      setNotice(null);
      setter(value);
    };
  }

  function validate(): string | null {
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
    const attempt = { name: operatorName.trim(), email: operatorEmail.trim().toLowerCase() };
    // A second press moves on: the first press saved everything, including the principal and
    // their profile — an undeliverable notice must never hold those back (#2710).
    if (notice && notice.name === attempt.name && notice.email === attempt.email) {
      onContinue();
      return;
    }
    const problem = validate();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      // The Setup row first: it marks Setup in progress, so the page stays the landing page.
      const saved = await saveSetupFields({
        setupFor,
        operatorName: setupFor === 'other' ? attempt.name : null,
        operatorEmail: setupFor === 'other' ? operatorEmail.trim() : null,
      });
      // The principal and their profile are saved whatever happened to the notice: this is the
      // only place either is written from step 1.
      await postJson('/api/setup/principal', { name: name.trim() });
      await postJson('/api/setup/principal/profile', {
        timezone: timezone.trim(),
        email: email.trim(),
        // Always sent: a blank clears the stored value.
        title: title.trim() || null,
        pronouns: pronouns.trim() || null,
      });
      await onSaved();

      const confirmation = saved.operatorConfirmation;
      if (confirmation && (confirmation.state === 'pending' || confirmation.state === 'failed')) {
        // Nothing is wrong with what was saved. On a fresh install Curia has no email account
        // yet, so it owes this notice and will send it after the restart; never frame that as a
        // mistake in the address. One press more, then the step moves on.
        setNotice({
          message: confirmation.state === 'pending'
            ? `Saved. We'll email ${attempt.email} to confirm once Curia's own email is set up.`
            : `Saved. The confirmation email to ${attempt.email} could not be sent yet; Curia will try again after the restart.`,
          ...attempt,
        });
        return;
      }
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
        onChange={edit(setSetupFor)}
        options={[
          { value: 'self', title: 'Myself', description: 'You’ll set it up, then go straight into your first conversation.' },
          { value: 'other', title: 'Someone else', description: 'An executive you work for. You set things up; they get an invitation when you’re ready.' },
        ]}
      />

      {other && (
        <>
          <div className="setup-section">
            <span className="setup-section-label">About you</span>
            <span className="setup-hint">Curia treats you as its operator: the person who looks after setup and admin. It will email you its technical notices, such as outages, sign-in problems and failing jobs. It won’t act on replies.</span>
          </div>
          <div className="setup-fields">
            <div className="setup-row2">
              <label className="setup-field">Your name
                <input type="text" value={operatorName} onChange={(e) => edit(setOperatorName)(e.target.value)} autoComplete="name" />
              </label>
              <label className="setup-field">Your email
                <input type="email" value={operatorEmail} onChange={(e) => edit(setOperatorEmail)(e.target.value)} autoComplete="email" />
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
                <input id="setup-principal-name" type="text" value={name} onChange={(e) => edit(setName)(e.target.value)} />
              </label>
              <label className="setup-field"><span className="setup-field-label">Title <span className="setup-hint">(optional)</span></span>
                <input type="text" value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
              </label>
            </div>
            <label className="setup-field">Email
              <input id="setup-principal-email" type="email" value={email} onChange={(e) => edit(setEmail)(e.target.value)} />
            </label>
            <div className="setup-row2">
              <label className="setup-field">Timezone
                <select value={timezone} onChange={(e) => edit(setTimezone)(e.target.value)}>
                  {!IANA_ZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
                  {IANA_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </label>
              <label className="setup-field"><span className="setup-field-label">Pronouns <span className="setup-hint">(optional)</span></span>
                <input type="text" value={pronouns} onChange={(e) => edit(setPronouns)(e.target.value)} placeholder="she/her" />
              </label>
            </div>
          </div>
        </>
      )}

      {error && <p className="setup-status attention" role="alert">{error}</p>}
      {notice && <p className="setup-status" role="status">{notice.message}</p>}
      <StepFooter primary={saving ? 'Saving…' : notice ? 'Continue' : 'Save and continue'} primaryDisabled={saving} onHelp={onHelp} submit />
    </form>
  );
}
