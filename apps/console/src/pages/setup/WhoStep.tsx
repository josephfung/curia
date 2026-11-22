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
  /** Set when the save recorded an operator but the confirmation notice to them failed: the
   *  step stays put on one warning rather than continuing and losing the only signal that the
   *  address may be mistyped (#2710). The values attempted are kept so a corrected address is
   *  saved again, and only an unchanged second press continues anyway. */
  const [noticeFailure, setNoticeFailure] = useState<{ message: string; name: string; email: string } | null>(null);

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
    // A second press continues past a failed confirmation, unless the address was corrected —
    // then it is saved again, because continuing would keep the address that did not work.
    if (noticeFailure && noticeFailure.name === attempt.name && noticeFailure.email === attempt.email) {
      onContinue();
      return;
    }
    const problem = validate();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    setNoticeFailure(null);
    try {
      // The Setup row first: it marks Setup in progress, so the page stays the landing page.
      const saved = await saveSetupFields({
        setupFor,
        operatorName: setupFor === 'other' ? attempt.name : null,
        operatorEmail: setupFor === 'other' ? operatorEmail.trim() : null,
      });
      if (saved.operatorNoticeSent === false) {
        // Saved, but the operator will not have heard from Curia. Say so before moving on.
        setNoticeFailure({
          message: `Saved, but the confirmation email to ${operatorEmail.trim()} could not be sent. Check the address, then continue.`,
          ...attempt,
        });
        return;
      }
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
              <label className="setup-field"><span className="setup-field-label">Title <span className="setup-hint">(optional)</span></span>
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
              <label className="setup-field"><span className="setup-field-label">Pronouns <span className="setup-hint">(optional)</span></span>
                <input type="text" value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="she/her" />
              </label>
            </div>
          </div>
        </>
      )}

      {error && <p className="setup-status attention" role="alert">{error}</p>}
      {noticeFailure && <p className="setup-status attention" role="alert">{noticeFailure.message}</p>}
      <StepFooter primary={saving ? 'Saving…' : noticeFailure ? 'Continue anyway' : 'Save and continue'} primaryDisabled={saving} onHelp={onHelp} submit />
    </form>
  );
}
