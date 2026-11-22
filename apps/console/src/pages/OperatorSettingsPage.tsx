import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { ConfigHistory, errorMessage, type ConfigHistoryEntry } from '../components/settings/ConfigHistory';

// The operator (#2710, ADR-068): the person who set Curia up when that was not the
// principal. Curia emails them its technical notices — one-way, with no replies acted on
// and no contact, tier or approval rights. Setup records them once; this page is how they
// are viewed, changed or cleared afterwards, because EAs leave.

interface Operator {
  name: string;
  email: string;
}

type SaveOutcome =
  | { kind: 'saved'; noticeSent: boolean }
  | { kind: 'cleared' }
  | { kind: 'error'; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function OperatorSection() {
  const [loaded, setLoaded] = useState<Operator | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const [history, setHistory] = useState<ConfigHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const res = await apiFetch('/api/operator/history?limit=10&offset=0');
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
      setHistory(data.history.map((h) => ({
        id: h.id,
        changedBy: h.changedBy,
        createdAt: h.changedAt,
        summary: `${describe(h.previous)} → ${describe(h.current)}`,
      })));
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load change history');
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/operator');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { operator: Operator | null };
        setLoaded(data.operator);
        setName(data.operator?.name ?? '');
        setEmail(data.operator?.email ?? '');
      } catch (err) {
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
      : !EMAIL_RE.test(trimmedEmail)
        ? "That doesn't look like an email address."
        : null;

  async function handleSave() {
    if (!changed || problem) return;
    setSaving(true);
    setOutcome(null);
    try {
      const res = await apiFetch('/api/operator', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { operator: Operator; noticeSent: boolean };
      setLoaded(data.operator);
      setName(data.operator.name);
      setEmail(data.operator.email);
      setOutcome({ kind: 'saved', noticeSent: data.noticeSent });
      void loadHistory();
    } catch (err) {
      setOutcome({ kind: 'error', message: err instanceof Error ? err.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
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
                  autoComplete="off"
                  placeholder="e.g. Sam Rivera"
                />
              </label>
              <label className="setup-field">Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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

          <div className="autonomy-control">
            <div className="autonomy-save-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!changed || saving || problem !== null}
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
                  {outcome.noticeSent
                    ? 'A confirmation went out to that address.'
                    : 'The confirmation notice could not be sent — check the address.'}
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
