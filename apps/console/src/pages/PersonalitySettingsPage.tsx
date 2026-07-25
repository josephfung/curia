import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { TonePillGrid, AssistantToneSliders } from '../components/settings/ToneFields';
import {
  ChangeNoteField,
  ConfigHistory,
  errorMessage,
  type ConfigHistoryEntry,
} from '../components/settings/ConfigHistory';
import type { LocalIdentity } from './wizard-utils';
import { validateNonEmptyName } from './wizard-utils';

interface VersionMeta {
  version: number;
  changedBy: string;
  createdAt: string;
  note?: string | null;
}

// Curia's own characteristics (name, title, signature, tone). Ghostwriting —
// drafting *as the principal* — is a separate page (/settings/ghostwriting).
function PersonalitySection() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [savedIdentity, setSavedIdentity] = useState<LocalIdentity | null>(null);
  const [identityMeta, setIdentityMeta] = useState<VersionMeta | null>(null);
  const [identityNote, setIdentityNote] = useState('');
  const [identityStatus, setIdentityStatus] = useState('');
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityHistory, setIdentityHistory] = useState<ConfigHistoryEntry[]>([]);
  const [identityHistoryError, setIdentityHistoryError] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadIdentityHistory = useCallback(async () => {
    setIdentityHistoryError(null);
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
      setIdentityHistory(data.history.map(h => ({
        id: h.id,
        version: h.version,
        changedBy: h.changedBy,
        note: h.note,
        createdAt: h.createdAt,
      })));
      const latest = data.history[0];
      if (latest) {
        setIdentityMeta({
          version: latest.version,
          changedBy: latest.changedBy,
          createdAt: latest.createdAt,
          note: latest.note,
        });
      }
    } catch (err) {
      setIdentityHistoryError(err instanceof Error ? err.message : 'Failed to load identity history');
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/identity');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { identity: LocalIdentity };
        setIdentity(data.identity);
        setSavedIdentity(data.identity);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load personality settings');
      }
    }
    void load();
    void loadIdentityHistory();
  }, [loadIdentityHistory]);

  async function saveIdentity() {
    if (!identity || !savedIdentity) return;
    if (!validateNonEmptyName(identity.assistant.name)) {
      setNameError('Assistant name is required.');
      return;
    }
    setNameError('');
    setIdentitySaving(true);
    setIdentityStatus('Saving…');
    try {
      // Re-fetch before write so concurrent Posture/Ghostwriting edits are not clobbered.
      const freshRes = await apiFetch('/api/identity');
      if (!freshRes.ok) throw new Error(await errorMessage(freshRes));
      const freshData = await freshRes.json() as { identity: LocalIdentity };
      const payload: LocalIdentity = {
        ...freshData.identity,
        assistant: {
          name: identity.assistant.name.trim(),
          title: identity.assistant.title.trim(),
          emailSignature: identity.assistant.emailSignature.trim(),
        },
        tone: {
          baseline: identity.tone.baseline,
          verbosity: identity.tone.verbosity,
          directness: identity.tone.directness,
        },
      };
      const res = await apiFetch('/api/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identity: payload,
          changedBy: 'api',
          note: identityNote.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { identity: LocalIdentity };
      setIdentity(data.identity);
      setSavedIdentity(data.identity);
      setIdentityNote('');
      setIdentityStatus('Saved');
      setTimeout(() => setIdentityStatus(''), 2000);
      void loadIdentityHistory();
    } catch (err) {
      setIdentityStatus(`Error: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setIdentitySaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="settings-page-header">
        <p className="autonomy-error">{loadError}</p>
      </div>
    );
  }

  if (!identity || !savedIdentity) {
    return (
      <div className="settings-page-header">
        <p className="settings-muted-hint">Loading…</p>
      </div>
    );
  }

  const identityDirty =
    identity.assistant.name.trim() !== savedIdentity.assistant.name.trim()
    || identity.assistant.title.trim() !== savedIdentity.assistant.title.trim()
    || identity.assistant.emailSignature.trim() !== savedIdentity.assistant.emailSignature.trim()
    || JSON.stringify(identity.tone) !== JSON.stringify(savedIdentity.tone);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Personality</h2>
        <p className="settings-page-sub">
          How Curia presents itself — its name, communication style, and personality in its own voice.
        </p>
        {identityMeta && (
          <p className="settings-version-meta">
            Identity v{identityMeta.version} · last changed by {identityMeta.changedBy}
          </p>
        )}
      </div>

      <section className="settings-section">
        <div className="settings-section-body">
          <div className="wizard-field">
            <label htmlFor="asst-name">Assistant name *</label>
            <input
              id="asst-name"
              type="text"
              value={identity.assistant.name}
              onChange={e => {
                setIdentity({ ...identity, assistant: { ...identity.assistant, name: e.target.value } });
                if (nameError) setNameError('');
              }}
            />
            {nameError && <div className="wizard-step1-error">{nameError}</div>}
          </div>
          <div className="wizard-field">
            <label htmlFor="asst-title">Title</label>
            <input
              id="asst-title"
              type="text"
              value={identity.assistant.title}
              onChange={e => setIdentity({
                ...identity,
                assistant: { ...identity.assistant, title: e.target.value },
              })}
            />
          </div>
          <div className="wizard-field">
            <label htmlFor="asst-signature">Email signature</label>
            <textarea
              id="asst-signature"
              value={identity.assistant.emailSignature}
              onChange={e => setIdentity({
                ...identity,
                assistant: { ...identity.assistant, emailSignature: e.target.value },
              })}
            />
          </div>

          <TonePillGrid
            selected={identity.tone.baseline}
            onChange={baseline => setIdentity({
              ...identity,
              tone: { ...identity.tone, baseline },
            })}
            idPrefix="asst-tone"
          />
          <AssistantToneSliders
            verbosity={identity.tone.verbosity}
            directness={identity.tone.directness}
            onVerbosityChange={verbosity => setIdentity({
              ...identity,
              tone: { ...identity.tone, verbosity },
            })}
            onDirectnessChange={directness => setIdentity({
              ...identity,
              tone: { ...identity.tone, directness },
            })}
            idPrefix="asst"
          />

          <div className="autonomy-control">
            <ChangeNoteField id="asst-identity-note" value={identityNote} onChange={setIdentityNote} />
            <div className="autonomy-save-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!identityDirty || identitySaving}
                onClick={() => void saveIdentity()}
              >
                Save personality
              </button>
              {identityStatus && <span className="autonomy-save-status">{identityStatus}</span>}
            </div>
          </div>
          <ConfigHistory entries={identityHistory} error={identityHistoryError} />
        </div>
      </section>
    </>
  );
}

export function PersonalityPage() {
  return (
    <SettingsLayout activeSection="personality">
      <PersonalitySection />
    </SettingsLayout>
  );
}

export default PersonalityPage;
