import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { FormalitySlider } from '../components/settings/ToneFields';
import { StringListEditor } from '../components/settings/StringListEditor';
import {
  ChangeNoteField,
  ConfigHistory,
  errorMessage,
  type ConfigHistoryEntry,
} from '../components/settings/ConfigHistory';

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

// Ghostwriting = how Curia drafts when it writes *as the principal* (emails,
// messages). Distinct from Curia's own personality (/settings/personality).
function GhostwritingSection() {
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
        setVoiceMeta({ version: latest.version, changedBy: latest.changedBy });
      }
    } catch (err) {
      setVoiceHistoryError(err instanceof Error ? err.message : 'Failed to load writing-voice history');
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/executive');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { profile: ExecutiveProfile };
        setProfile(data.profile);
        setSavedVoice(data.profile.writingVoice);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load ghostwriting settings');
      }
    }
    void load();
    void loadVoiceHistory();
  }, [loadVoiceHistory]);

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

  if (!profile || !savedVoice) {
    return (
      <div className="settings-page-header">
        <p className="settings-muted-hint">Loading…</p>
      </div>
    );
  }

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
        <h2 className="settings-page-title">Ghostwriting</h2>
        <p className="settings-page-sub">
          How Curia drafts when it writes as you — emails and messages in your voice.
          Separate from Curia&apos;s own personality.
        </p>
        {voiceMeta && (
          <p className="settings-version-meta">
            Voice v{voiceMeta.version} · last changed by {voiceMeta.changedBy}
          </p>
        )}
      </div>

      <section className="settings-section">
        <div className="settings-section-body">
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
              placeholder="e.g. Best, Joseph"
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

          <div className="autonomy-control">
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
        </div>
      </section>
    </>
  );
}

export function GhostwritingPage() {
  return (
    <SettingsLayout activeSection="ghostwriting">
      <GhostwritingSection />
    </SettingsLayout>
  );
}

export default GhostwritingPage;
