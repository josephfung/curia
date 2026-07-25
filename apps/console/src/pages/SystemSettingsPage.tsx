import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { errorMessage, timeAgo } from '../components/settings/ConfigHistory';

interface SystemModelTier {
  tier: string;
  model: string;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  timezone: string;
  bootedAt: string;
  models: {
    defaultTier: string;
    tiers: SystemModelTier[];
  };
}

// Runtime guard for the /api/system payload — a malformed 200 must not reach
// state and crash the render (same defensive pattern as the Memory page).
function isSystemInfo(value: unknown): value is SystemInfo {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  const models = s['models'];
  if (typeof models !== 'object' || models === null) return false;
  const m = models as Record<string, unknown>;
  return typeof s['version'] === 'string'
    && typeof s['nodeVersion'] === 'string'
    && typeof s['timezone'] === 'string'
    && typeof s['bootedAt'] === 'string'
    && typeof m['defaultTier'] === 'string'
    && Array.isArray(m['tiers'])
    && m['tiers'].every(t =>
      typeof t === 'object' && t !== null
      && typeof (t as Record<string, unknown>)['tier'] === 'string'
      && typeof (t as Record<string, unknown>)['model'] === 'string');
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function SystemSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/system');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { system: unknown };
        if (!isSystemInfo(data.system)) {
          throw new Error('Malformed system response');
        }
        setInfo(data.system);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load system info');
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

  if (!info) {
    return (
      <div className="settings-page-header">
        <p className="settings-muted-hint">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">System</h2>
        <p className="settings-page-sub">
          Environment and configuration for this Curia instance.
        </p>
      </div>

      <div className="settings-callout settings-callout-readonly">
        <p>
          <strong>Read-only.</strong> These values reflect the currently running process.
          Changing them requires a config change and a restart.
        </p>
      </div>

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Instance</h3>
        </div>
        <div className="settings-section-body">
          <dl className="settings-kv-list">
            <div className="settings-kv-row">
              <dt>Curia version</dt>
              <dd><code>{info.version}</code></dd>
            </div>
            <div className="settings-kv-row">
              <dt>Node runtime</dt>
              <dd><code>{info.nodeVersion}</code></dd>
            </div>
            <div className="settings-kv-row">
              <dt>Timezone</dt>
              <dd>{info.timezone}</dd>
            </div>
            <div className="settings-kv-row">
              <dt>Booted</dt>
              <dd title={info.bootedAt}>{timeAgo(info.bootedAt)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Models</h3>
          <p className="settings-section-sub">
            Capability tier → model routing. Agents pick a tier; the deployment maps it here.
          </p>
        </div>
        <div className="settings-section-body">
          <dl className="settings-kv-list">
            {info.models.tiers.map(t => (
              <div className="settings-kv-row" key={t.tier}>
                <dt>
                  {capitalize(t.tier)}
                  {t.tier === info.models.defaultTier && (
                    <span className="settings-kv-tag">default</span>
                  )}
                </dt>
                <dd><code>{t.model}</code></dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </>
  );
}

export function SystemPage() {
  return (
    <SettingsLayout activeSection="system">
      <SystemSection />
    </SettingsLayout>
  );
}

export default SystemPage;
