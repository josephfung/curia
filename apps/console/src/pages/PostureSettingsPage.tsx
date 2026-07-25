import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { PostureCardGrid } from '../components/settings/PostureFields';
import { StringListEditor } from '../components/settings/StringListEditor';
import {
  ChangeNoteField,
  ConfigHistory,
  errorMessage,
  type ConfigHistoryEntry,
} from '../components/settings/ConfigHistory';
import type { DecisionPosture, LocalIdentity } from './wizard-utils';

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
        setLoadError(err instanceof Error ? err.message : 'Failed to load posture settings');
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
      // Re-fetch before write so concurrent Assistant persona edits are not clobbered.
      const freshRes = await apiFetch('/api/identity');
      if (!freshRes.ok) throw new Error(await errorMessage(freshRes));
      const freshData = await freshRes.json() as { identity: LocalIdentity };
      const payload: LocalIdentity = {
        ...freshData.identity,
        decisionStyle: {
          ...freshData.identity.decisionStyle,
          externalActions: identity.decisionStyle.externalActions,
          internalAnalysis: identity.decisionStyle.internalAnalysis,
        },
        behavioralPreferences: identity.behavioralPreferences,
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

  const isDirty =
    identity.decisionStyle.externalActions !== saved.decisionStyle.externalActions
    || identity.decisionStyle.internalAnalysis !== saved.decisionStyle.internalAnalysis
    || JSON.stringify(identity.behavioralPreferences) !== JSON.stringify(saved.behavioralPreferences);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Posture</h2>
        <p className="settings-page-sub">
          Default decision style and standing preferences for your assistant.
        </p>
        {meta && (
          <p className="settings-version-meta">
            Identity v{meta.version} · last changed by {meta.changedBy}
          </p>
        )}
      </div>

      <div className="settings-callout">
        <p>
          <strong>Posture vs autonomy.</strong> Decision posture is the assistant&apos;s
          default bias when judging external actions (verify first vs act when confident).
          The{' '}
          <Link to="/settings/autonomy">Autonomy score</Link>
          {' '}is a separate knob: how far Curia may proceed before stopping for your
          confirmation. Adjust both independently.
        </p>
      </div>

      <section className="settings-section">
        <PostureCardGrid
          value={identity.decisionStyle.externalActions}
          onChange={(externalActions: DecisionPosture) => setIdentity({
            ...identity,
            decisionStyle: { ...identity.decisionStyle, externalActions },
          })}
          scopeHint="(for external actions)"
        />

        <div style={{ marginTop: 20 }}>
          <PostureCardGrid
            value={identity.decisionStyle.internalAnalysis}
            onChange={(internalAnalysis: DecisionPosture) => setIdentity({
              ...identity,
              decisionStyle: { ...identity.decisionStyle, internalAnalysis },
            })}
            scopeHint="(for internal analysis)"
          />
        </div>

        <div style={{ marginTop: 24 }}>
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

        <div className="autonomy-control" style={{ marginTop: 20 }}>
          <ChangeNoteField id="posture-note" value={note} onChange={setNote} />
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
