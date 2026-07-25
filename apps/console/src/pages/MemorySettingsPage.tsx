import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { errorMessage } from '../components/settings/ConfigHistory';

export interface MemoryRetentionPolicy {
  workingMemoryTtlDays: number;
  scratchTtlDays: number;
  archiveThreshold: number;
  halfLifeDays: {
    slowDecay: number;
    fastDecay: number;
  };
  warnHoldBackDays: number;
  editable: false;
}

function MemorySection() {
  const [policy, setPolicy] = useState<MemoryRetentionPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/memory/retention');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { retention: MemoryRetentionPolicy };
        setPolicy(data.retention);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load retention policy');
      }
    }
    void load();
  }, []);

  if (loadError) {
    return (
      <div className="settings-page-header">
        <p className="autonomy-error">{loadError}</p>
      </div>
    );
  }

  if (!policy) {
    return (
      <div className="settings-page-header">
        <p className="settings-muted-hint">Loading…</p>
      </div>
    );
  }

  const archivePct = Math.round(policy.archiveThreshold * 1000) / 10;

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Memory</h2>
        <p className="settings-page-sub">
          How long conversation turns and knowledge-graph facts are kept before decay or archival.
        </p>
      </div>

      <div className="settings-callout settings-callout-readonly">
        <p>
          <strong>Read-only — configured at deploy time.</strong> These values are loaded from
          server config at boot. Changing them requires a config edit and restart. In-console
          editing is a future enhancement.
        </p>
      </div>

      <section className="settings-section">
        <h3 className="settings-section-title">Conversation &amp; scratch</h3>
        <dl className="retention-list">
          <div className="retention-row">
            <dt>Conversation turns</dt>
            <dd>
              Kept for <strong>{policy.workingMemoryTtlDays} days</strong>, then purged by the
              nightly dream pass.
            </dd>
          </div>
          <div className="retention-row">
            <dt>Scratch documents</dt>
            <dd>
              Ephemeral scratch docs are archived after{' '}
              <strong>{policy.scratchTtlDays} days</strong> of inactivity.
            </dd>
          </div>
        </dl>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Fact decay</h3>
        <dl className="retention-list">
          <div className="retention-row">
            <dt>Slow-decay facts</dt>
            <dd>
              Confidence halves every <strong>{policy.halfLifeDays.slowDecay} days</strong>
              {' '}(employer, residence, and similar long-lived facts).
            </dd>
          </div>
          <div className="retention-row">
            <dt>Fast-decay facts</dt>
            <dd>
              Confidence halves every <strong>{policy.halfLifeDays.fastDecay} days</strong>
              {' '}(preferences and short-lived context).
            </dd>
          </div>
          <div className="retention-row">
            <dt>Archive threshold</dt>
            <dd>
              Facts at or below <strong>{archivePct}% confidence</strong> are soft-deleted
              (archived) and drop out of queries.
            </dd>
          </div>
          <div className="retention-row">
            <dt>Decay warnings</dt>
            <dd>
              Important nodes about to archive are held back for{' '}
              <strong>{policy.warnHoldBackDays} days</strong> so you can re-confirm them.
            </dd>
          </div>
        </dl>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Review nodes</h3>
        <p className="settings-page-sub">
          To review knowledge-graph nodes nearing archival, ask Curia in{' '}
          <Link to="/chat">Chat</Link>
          {' '}to run the decay-warnings list (the <code>decay-warnings-list</code> skill).
        </p>
      </section>
    </>
  );
}

export function MemoryPage() {
  return (
    <SettingsLayout activeSection="memory">
      <MemorySection />
    </SettingsLayout>
  );
}

export default MemoryPage;
