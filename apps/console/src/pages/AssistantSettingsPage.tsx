import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { TonePillGrid, AssistantToneSliders, FormalitySlider } from '../components/settings/ToneFields';
import { StringListEditor } from '../components/settings/StringListEditor';
import {
  ChangeNoteField,
  ConfigHistory,
  errorMessage,
  type ConfigHistoryEntry,
} from '../components/settings/ConfigHistory';
import type { LocalIdentity } from './wizard-utils';
import { validateNonEmptyName } from './wizard-utils';

interface WritingVoice {
  tone: string[];
  formality: number;
  patterns: string[];
  vocabulary: { prefer: string[]; avoid: string[] };
  signOff: string;
  guide: string;
}

interface ExecutiveProfile {
  writingVoice: WritingVoice;
}

interface VersionMeta {
  version: number;
  changedBy: string;
  createdAt: string;
  note?: string | null;
}

function voicesEqual(a: WritingVoice, b: WritingVoice): boolean {
  // Ignore guide — operator edits must preserve it but it is not in the form.
  return JSON.stringify({
    tone: a.tone,
    formality: a.formality,
    patterns: a.patterns,
    vocabulary: a.vocabulary,
    signOff: a.signOff,
  }) === JSON.stringify({
    tone: b.tone,
    formality: b.formality,
    patterns: b.patterns,
    vocabulary: b.vocabulary,
    signOff: b.signOff,
  });
}

function AssistantSection() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [savedIdentity, setSavedIdentity] = useState<LocalIdentity | null>(null);
  const [identityMeta, setIdentityMeta] = useState<VersionMeta | null>(null);
  const [identityNote, setIdentityNote] = useState('');
  const [identityStatus, setIdentityStatus] = useState('');
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityHistory, setIdentityHistory] = useState<ConfigHistoryEntry[]>([]);
  const [identityHistoryError, setIdentityHistoryError] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');

  const [profile, setProfile] = useState<ExecutiveProfile | null>(null);
  const [savedVoice, setSavedVoice] = useState<WritingVoice | null>(null);
  const [voiceMeta, setVoiceMeta] = useState<VersionMeta | null>(null);
  const [voiceNote, setVoiceNote] = useState('');
  const [voiceStatus, setVoiceStatus] = useState('');
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceHistory, setVoiceHistory] = useState<ConfigHistoryEntry[]>([]);
  const [voiceHistoryError, setVoiceHistoryError] = useState<string | null>(null);
  const [toneDraft, setToneDraft] = useState('');

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

  const loadVoiceHistory = useCallback(async () => {
    setVoiceHistoryError(null);
    try {
      const res = await apiFetch('/api/executive/history');
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
      setVoiceHistory(data.history.map(h => ({
        id: h.id,
        version: h.version,
        changedBy: h.changedBy,
        note: h.note,
        createdAt: h.createdAt,
      })));
      const latest = data.history[0];
      if (latest) {
        setVoiceMeta({
          version: latest.version,
          changedBy: latest.changedBy,
          createdAt: latest.createdAt,
          note: latest.note,
        });
      }
    } catch (err) {
      setVoiceHistoryError(err instanceof Error ? err.message : 'Failed to load writing-voice history');
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const [idRes, exRes] = await Promise.all([
          apiFetch('/api/identity'),
          apiFetch('/api/executive'),
        ]);
        if (!idRes.ok) throw new Error(await errorMessage(idRes));
        if (!exRes.ok) throw new Error(await errorMessage(exRes));
        const idData = await idRes.json() as { identity: LocalIdentity };
        const exData = await exRes.json() as { profile: ExecutiveProfile };
        setIdentity(idData.identity);
        setSavedIdentity(idData.identity);
        setProfile(exData.profile);
        setSavedVoice(exData.profile.writingVoice);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load assistant settings');
      }
    }
    void load();
    void loadIdentityHistory();
    void loadVoiceHistory();
  }, [loadIdentityHistory, loadVoiceHistory]);

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
      // Re-fetch before write so concurrent Posture edits are not clobbered.
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

  async function saveVoice() {
    if (!profile || !savedVoice) return;
    setVoiceSaving(true);
    setVoiceStatus('Saving…');
    try {
      // Re-fetch so the LLM-learned guide (and any other concurrent edits) are preserved.
      const freshRes = await apiFetch('/api/executive');
      if (!freshRes.ok) throw new Error(await errorMessage(freshRes));
      const freshData = await freshRes.json() as { profile: ExecutiveProfile };
      const writingVoice: WritingVoice = {
        tone: profile.writingVoice.tone,
        formality: profile.writingVoice.formality,
        patterns: profile.writingVoice.patterns,
        vocabulary: profile.writingVoice.vocabulary,
        signOff: profile.writingVoice.signOff.trim(),
        guide: freshData.profile.writingVoice.guide,
      };
      const res = await apiFetch('/api/executive', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: { writingVoice },
          changedBy: 'api',
          note: voiceNote.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { profile: ExecutiveProfile };
      setProfile(data.profile);
      setSavedVoice(data.profile.writingVoice);
      setVoiceNote('');
      setVoiceStatus('Saved');
      setTimeout(() => setVoiceStatus(''), 2000);
      void loadVoiceHistory();
    } catch (err) {
      setVoiceStatus(`Error: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setVoiceSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="settings-page-header">
        <p className="autonomy-error">{loadError}</p>
      </div>
    );
  }

  if (!identity || !profile || !savedIdentity || !savedVoice) {
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

  const voiceDirty = !voicesEqual(profile.writingVoice, savedVoice);

  function addVoiceTone() {
    const trimmed = toneDraft.trim();
    if (!trimmed) return;
    const current = profile!.writingVoice.tone;
    if (current.includes(trimmed) || current.length >= 3) {
      setToneDraft('');
      return;
    }
    setProfile({
      ...profile!,
      writingVoice: { ...profile!.writingVoice, tone: [...current, trimmed] },
    });
    setToneDraft('');
  }

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Assistant</h2>
        <p className="settings-page-sub">
          Name, communication style, and how Curia drafts in your voice.
        </p>
        {identityMeta && (
          <p className="settings-version-meta">
            Identity v{identityMeta.version} · last changed by {identityMeta.changedBy}
          </p>
        )}
      </div>

      <section className="settings-section">
        <h3 className="settings-section-title">Persona</h3>
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

        <div className="autonomy-control" style={{ marginTop: 20 }}>
          <ChangeNoteField id="asst-identity-note" value={identityNote} onChange={setIdentityNote} />
          <div className="autonomy-save-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!identityDirty || identitySaving}
              onClick={() => void saveIdentity()}
            >
              Save persona
            </button>
            {identityStatus && <span className="autonomy-save-status">{identityStatus}</span>}
          </div>
        </div>
        <ConfigHistory entries={identityHistory} error={identityHistoryError} />
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Writing voice</h3>
        <p className="settings-page-sub" style={{ marginBottom: 16 }}>
          How Curia drafts when writing as you (emails, messages). Separate from the assistant&apos;s own tone above.
        </p>
        {voiceMeta && (
          <p className="settings-version-meta">
            Voice v{voiceMeta.version} · last changed by {voiceMeta.changedBy}
          </p>
        )}

        <div className="wizard-label">
          Tone descriptors{' '}
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            (up to 3, free-form)
          </span>
        </div>
        <div className="tone-pill-grid" style={{ marginBottom: 8 }}>
          {profile.writingVoice.tone.map(word => (
            <button
              key={word}
              type="button"
              className="tone-pill selected"
              onClick={() => setProfile({
                ...profile,
                writingVoice: {
                  ...profile.writingVoice,
                  tone: profile.writingVoice.tone.filter(t => t !== word),
                },
              })}
              title="Click to remove"
            >
              {word} ×
            </button>
          ))}
        </div>
        {profile.writingVoice.tone.length < 3 && (
          <div className="string-list-add-row" style={{ marginBottom: 16 }}>
            <input
              type="text"
              value={toneDraft}
              placeholder="e.g. crisp, warm"
              onChange={e => setToneDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addVoiceTone();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!toneDraft.trim()}
              onClick={addVoiceTone}
            >
              Add
            </button>
          </div>
        )}

        <FormalitySlider
          value={profile.writingVoice.formality}
          onChange={formality => setProfile({
            ...profile,
            writingVoice: { ...profile.writingVoice, formality },
          })}
          id="voice-formality"
        />

        <StringListEditor
          id="voice-patterns"
          label="Style patterns"
          items={profile.writingVoice.patterns}
          onChange={patterns => setProfile({
            ...profile,
            writingVoice: { ...profile.writingVoice, patterns },
          })}
          placeholder="e.g. Concise and to the point"
          emptyHint="No patterns yet."
        />

        <StringListEditor
          id="voice-prefer"
          label="Prefer these words"
          items={profile.writingVoice.vocabulary.prefer}
          onChange={prefer => setProfile({
            ...profile,
            writingVoice: {
              ...profile.writingVoice,
              vocabulary: { ...profile.writingVoice.vocabulary, prefer },
            },
          })}
          placeholder="Add a preferred word or phrase"
        />

        <StringListEditor
          id="voice-avoid"
          label="Avoid these words"
          items={profile.writingVoice.vocabulary.avoid}
          onChange={avoid => setProfile({
            ...profile,
            writingVoice: {
              ...profile.writingVoice,
              vocabulary: { ...profile.writingVoice.vocabulary, avoid },
            },
          })}
          placeholder="Add a word or phrase to avoid"
        />

        <div className="wizard-field">
          <label htmlFor="voice-signoff">Sign-off</label>
          <input
            id="voice-signoff"
            type="text"
            value={profile.writingVoice.signOff}
            placeholder="e.g. Best, — Joseph"
            onChange={e => setProfile({
              ...profile,
              writingVoice: { ...profile.writingVoice, signOff: e.target.value },
            })}
          />
        </div>

        {savedVoice.guide && (
          <p className="settings-muted-hint" style={{ marginTop: 8 }}>
            A learned voice guide is active (updated by weekly voice-learn). Operator edits here keep it intact.
          </p>
        )}

        <div className="autonomy-control" style={{ marginTop: 20 }}>
          <ChangeNoteField id="asst-voice-note" value={voiceNote} onChange={setVoiceNote} />
          <div className="autonomy-save-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!voiceDirty || voiceSaving}
              onClick={() => void saveVoice()}
            >
              Save writing voice
            </button>
            {voiceStatus && <span className="autonomy-save-status">{voiceStatus}</span>}
          </div>
        </div>
        <ConfigHistory entries={voiceHistory} error={voiceHistoryError} />
      </section>
    </>
  );
}

export function AssistantPage() {
  return (
    <SettingsLayout activeSection="assistant">
      <AssistantSection />
    </SettingsLayout>
  );
}

export default AssistantPage;
