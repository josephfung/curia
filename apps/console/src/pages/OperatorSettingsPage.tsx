import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { ConfigHistory, errorMessage, timeAgo, type ConfigHistoryEntry } from '../components/settings/ConfigHistory';

// The operator (#2710, ADR-068): the person who set Curia up when that was not the
// principal. Curia emails them its technical notices — one-way, with no replies acted on
// and no contact, tier or approval rights. Setup records them once; this page is how they
// are viewed, changed or cleared afterwards, because EAs leave.

interface Operator {
  name: string;
  email: string;
}

/** Where the operator's confirmation notice stands (#2710). */
type ConfirmationState = 'none' | 'pending' | 'sent' | 'failed';

interface Confirmation {
  state: ConfirmationState;
  email?: string;
  attemptedAt?: string;
  sentAt?: string;
}

type SaveOutcome =
  | { kind: 'saved'; confirmation: Confirmation | null }
  | { kind: 'cleared' }
  | { kind: 'error'; message: string };

/** One line about the confirmation: the typo check, and what happens next when it did not run. */
function confirmationLine(confirmation: Confirmation | null): string | null {
  if (!confirmation) return null;
  switch (confirmation.state) {
    case 'sent':
      // "Queued": a publish is all Curia knows at this point. A refused or failed delivery comes
      // back later and flips this to failed (#2710).
      return confirmation.sentAt
        ? `A confirmation notice was queued for ${confirmation.email} ${timeAgo(confirmation.sentAt)}.`
        : `A confirmation notice was queued for ${confirmation.email}.`;
    case 'pending':
      return `Curia will email ${confirmation.email} to confirm once its own email is set up.`;
    case 'failed':
      return confirmation.attemptedAt
        ? `The confirmation to ${confirmation.email} could not be sent ${timeAgo(confirmation.attemptedAt)}; Curia will try again. Check the address if it looks wrong.`
        : `The confirmation could not be sent; Curia will try again.`;
    case 'none':
      return null;
  }
}

// The server's rule (src/settings/registry.ts): the same pattern, at most 254 characters.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function OperatorSection() {
  const [loaded, setLoaded] = useState<Operator | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The fields stay disabled until the first load lands, and while a save or clear is in flight,
  // so nothing typed is overwritten by a response for earlier values.
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const [history, setHistory] = useState<ConfigHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Latest-request guards: a response that is not for the newest request is dropped, so a slow
  // history fetch cannot replace a newer list, and the mount-time load cannot overwrite a save or
  // an edit made while it was in flight.
  const historySeq = useRef(0);
  const loadSeq = useRef(0);

  const loadHistory = useCallback(async () => {
    const seq = ++historySeq.current;
    setHistoryError(null);
    try {
      const res = await apiFetch('/api/operator/history?limit=10&offset=0');
      if (seq !== historySeq.current) return;
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as {
        history: Array<{
          id: string;
          previous: Operator | null | 'unreadable';
          current: Operator | null | 'unreadable';
          changedBy: string;
          changedAt: string;
        }>;
      };
      if (seq !== historySeq.current) return;
      setHistory(data.history.map((h) => ({
        id: h.id,
        changedBy: h.changedBy,
        createdAt: h.changedAt,
        summary: `${describe(h.previous)} → ${describe(h.current)}`,
      })));
    } catch (err) {
      if (seq !== historySeq.current) return;
      setHistoryError(err instanceof Error ? err.message : 'Failed to load change history');
    }
  }, []);

  useEffect(() => {
    async function load() {
      const seq = ++loadSeq.current;
      try {
        const res = await apiFetch('/api/operator');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { operator: Operator | null; confirmation?: Confirmation };
        // A save or clear since this load started has the newer value; keep it.
        if (seq !== loadSeq.current) return;
        setLoaded(data.operator);
        setConfirmation(data.confirmation ?? null);
        setName(data.operator?.name ?? '');
        setEmail(data.operator?.email ?? '');
        setReady(true);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load the operator setting');
      }
    }
    void load();
    void loadHistory();
  }, [loadHistory]);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const changed = loaded === null
    ? trimmedName !== '' || trimmedEmail !== ''
    : trimmedName !== loaded.name || trimmedEmail !== loaded.email;
  const problem = trimmedName === ''
    ? "Add the operator's name."
    : trimmedEmail === ''
      ? "Add the operator's email."
      : trimmedEmail.length > 254 || !EMAIL_RE.test(trimmedEmail)
        ? "That doesn't look like an email address."
        : null;

  async function handleSave() {
    if (!ready || !changed || problem) return;
    loadSeq.current++;
    setSaving(true);
    setOutcome(null);
    try {
      const res = await apiFetch('/api/operator', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { operator: Operator; confirmation?: Confirmation };
      setLoaded(data.operator);
      setConfirmation(data.confirmation ?? null);
      setName(data.operator.name);
      setEmail(data.operator.email);
      setOutcome({ kind: 'saved', confirmation: data.confirmation ?? null });
      void loadHistory();
    } catch (err) {
      setOutcome({ kind: 'error', message: err instanceof Error ? err.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    loadSeq.current++;
    setSaving(true);
    setOutcome(null);
    try {
      const res = await apiFetch('/api/operator', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setLoaded(null);
      setConfirmation(null);
      setName('');
      setEmail('');
      setConfirmingClear(false);
      setOutcome({ kind: 'cleared' });
      void loadHistory();
    } catch (err) {
      setOutcome({ kind: 'error', message: err instanceof Error ? err.message : 'Could not clear.' });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="settings-page-header">
        <p className="autonomy-error">{loadError}</p>
      </div>
    );
  }

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Operator</h2>
        <p className="settings-page-sub">
          The person who set Curia up, when that wasn&apos;t the executive. Curia emails them its
          technical notices: the database being down, a Google Workspace policy blocking a sign-in,
          or a scheduled job that keeps failing.
        </p>
      </div>

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Who hears about technical problems</h3>
        </div>
        <div className="settings-section-body">
          <div className="settings-callout">
            <p>
              {loaded
                ? <>Notices go to <strong>{loaded.email}</strong> only. Curia acts on nothing the operator replies with, and they are not a contact or an approver.</>
                : <>No operator is set: notices go to the principal&apos;s own address, as they did before Setup recorded one.</>}
            </p>
          </div>

          <div className="setup-fields">
            <div className="setup-row2">
              <label className="setup-field">Name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!ready || saving}
                  autoComplete="off"
                  placeholder="e.g. Sam Rivera"
                />
              </label>
              <label className="setup-field">Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!ready || saving}
                  autoComplete="off"
                  placeholder="sam@example.com"
                />
              </label>
            </div>
          </div>
          <p className="settings-muted-hint">
            Saving emails this address a short confirmation, so a typo shows up now rather than
            swallowing an alert later.
          </p>
          {confirmationLine(loaded ? confirmation : null) && (
            <p className="settings-muted-hint" role="status">
              {confirmationLine(loaded ? confirmation : null)}
            </p>
          )}

          <div className="autonomy-control">
            <div className="autonomy-save-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!ready || !changed || saving || problem !== null}
                onClick={() => void handleSave()}
                title={problem ?? undefined}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {loaded && !confirmingClear && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={() => setConfirmingClear(true)}
                >
                  Clear
                </button>
              )}
              {confirmingClear && (
                <>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={saving}
                    onClick={() => void handleClear()}
                  >
                    Yes, clear the operator
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={saving}
                    onClick={() => setConfirmingClear(false)}
                  >
                    Cancel
                  </button>
                </>
              )}
              {problem && <span className="autonomy-save-status">{problem}</span>}
              {outcome?.kind === 'saved' && (
                <span className="autonomy-save-status">
                  Saved.{' '}
                  {outcome.confirmation?.state === 'sent'
                    ? 'The confirmation is queued for that address.'
                    : outcome.confirmation?.state === 'failed'
                      ? 'The confirmation could not be sent; Curia will try again.'
                      : 'The confirmation is queued until Curia can email.'}
                </span>
              )}
              {outcome?.kind === 'cleared' && (
                <span className="autonomy-save-status">
                  Cleared. Notices go to the principal&apos;s address again.
                </span>
              )}
              {outcome?.kind === 'error' && <span className="autonomy-error">{outcome.message}</span>}
            </div>
          </div>

          <ConfigHistory entries={history} error={historyError} emptyLabel="No changes yet." />
        </div>
      </section>
    </>
  );
}

/** One history row's value, as the summary text. */
function describe(value: Operator | null | 'unreadable'): string {
  if (value === 'unreadable') return 'unreadable value';
  if (value === null) return 'cleared';
  return `${value.name} <${value.email}>`;
}

export function OperatorPage() {
  return (
    <SettingsLayout group="system" activeSection="operator">
      <OperatorSection />
    </SettingsLayout>
  );
}

export default OperatorPage;
