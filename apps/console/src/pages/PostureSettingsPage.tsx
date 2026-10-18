import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { StringListEditor } from '../components/settings/StringListEditor';
import {
  ChangeNoteField,
  ConfigHistory,
  errorMessage,
  type ConfigHistoryEntry,
} from '../components/settings/ConfigHistory';
import type { LocalIdentity } from './wizard-utils';

// Standing preferences: rules the assistant always follows. The route stays
// /settings/posture so existing links work; the decision-posture cards it used to hold
// are gone (#2143) — the autonomy level owns act-vs-ask.
function PostureSection() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [saved, setSaved] = useState<LocalIdentity | null>(null);
  const [note, setNote] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<ConfigHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ version: number; changedBy: string } | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const res = await apiFetch('/api/identity/history');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as {
        history: Array<{
          id: number;
          version: number;
          changedBy: string;
          note?: string | null;
          createdAt: string;
        }>;
      };
      setHistory(data.history.map(h => ({
        id: h.id,
        version: h.version,
        changedBy: h.changedBy,
        note: h.note,
        createdAt: h.createdAt,
      })));
      const latest = data.history[0];
      if (latest) {
        setMeta({ version: latest.version, changedBy: latest.changedBy });
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history');
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/identity');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { identity: LocalIdentity };
        setIdentity(data.identity);
        setSaved(data.identity);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load standing preferences');
      }
    }
    void load();
    void loadHistory();
  }, [loadHistory]);

  async function handleSave() {
    if (!identity || !saved) return;
    setSaving(true);
    setSaveStatus('Saving…');
    try {
      // Re-fetch before write so concurrent Personality edits are not clobbered.
      const freshRes = await apiFetch('/api/identity');
      if (!freshRes.ok) throw new Error(await errorMessage(freshRes));
      const freshData = await freshRes.json() as { identity: LocalIdentity };
      // Only overwrite the preferences when the operator changed them on this page;
      // keep the freshly-fetched values otherwise, so a background skill's append
      // (e.g. preference-update) after this page loaded is not clobbered.
      const payload: LocalIdentity = {
        ...freshData.identity,
        behavioralPreferences:
          JSON.stringify(identity.behavioralPreferences) !== JSON.stringify(saved.behavioralPreferences)
            ? identity.behavioralPreferences
            : freshData.identity.behavioralPreferences,
      };
      const res = await apiFetch('/api/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identity: payload,
          changedBy: 'api',
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { identity: LocalIdentity };
      setIdentity(data.identity);
      setSaved(data.identity);
      setNote('');
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);
      void loadHistory();
    } catch (err) {
      setSaveStatus(`Error: ${err instanceof Error ? err.message : 'unknown error'}`);
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

  if (!identity || !saved) {
    return (
      <div className="settings-page-header">
        <p className="settings-muted-hint">Loading…</p>
      </div>
    );
  }

  const isDirty = JSON.stringify(identity.behavioralPreferences) !== JSON.stringify(saved.behavioralPreferences);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Standing preferences</h2>
        <p className="settings-page-sub">
          Rules your assistant always follows. How it sounds goes in Personality → Tone &amp; style;
          how independently it acts is the Autonomy setting.
        </p>
        {meta && (
          <p className="settings-version-meta">
            Identity v{meta.version} · last changed by {meta.changedBy}
          </p>
        )}
      </div>

      <section className="settings-section">
        <div className="settings-section-body">
          <div>
            <StringListEditor
              id="standing-prefs"
              label="Standing preferences"
              items={identity.behavioralPreferences}
              onChange={behavioralPreferences => setIdentity({
                ...identity,
                behavioralPreferences,
              })}
              placeholder="e.g. Always include agenda items in meeting requests"
              emptyHint="No standing preferences yet."
            />
            <p className="settings-muted-hint">
              Standing preferences are part of the office identity. Edits replace the full
              list; the setup wizard only appends.
            </p>
          </div>

          <div className="autonomy-control">
            <ChangeNoteField id="preferences-note" value={note} onChange={setNote} />
            <div className="autonomy-save-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!isDirty || saving}
                onClick={() => void handleSave()}
              >
                Save
              </button>
              {saveStatus && <span className="autonomy-save-status">{saveStatus}</span>}
            </div>
          </div>

          <ConfigHistory entries={history} error={historyError} />
        </div>
      </section>
    </>
  );
}

export function PosturePage() {
  return (
    <SettingsLayout activeSection="posture">
      <PostureSection />
    </SettingsLayout>
  );
}

export default PosturePage;
