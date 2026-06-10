import { useState, useEffect, useCallback } from 'react';
import { SettingsLayout } from './SettingsPage.js';
import { apiFetch } from '../api.js';

// ── Types (mirror src/registry/types.ts RegistryEntry) ──────────────────────
type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

interface ManifestMetadata {
  name: string;
  description: string;
  version: string;
  actionRisk?: string | number;
  sensitivity?: string;
  capabilities?: string[];
  role?: string;
  modelTier?: string;
  // PR2 (#939): vault keys a skill declares in install.requires_secrets. Cross-referenced
  // against GET /api/vault/status to show configured/missing status and gate install/enable.
  requiresSecrets?: string[];
}

interface RegistryEntry {
  name: string;
  kind: 'skill' | 'agent';
  state: DerivedState;
  metadata: ManifestMetadata | null;
  manifestError?: string;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

// Map each DerivedState to one of the existing .status-pill modifier classes
// (app.css) so no new CSS is needed:
//   enabled     → confirmed (green)
//   installed   → provisional (amber)
//   ghost       → blocked (red) — manifest present on disk but DB row is gone
//   uninstalled → no modifier (neutral)
const STATE_PILL: Record<DerivedState, string> = {
  enabled:     'confirmed',
  installed:   'provisional',
  ghost:       'blocked',
  uninstalled: '',
};

// Safe error message extraction — guards against non-JSON error bodies.
async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch { /* fall through to HTTP status */ }
  }
  return `HTTP ${res.status}`;
}

// ── Required-secret row (status + inline entry) ──────────────────────────────
//
// One required vault key. Shows a configured/missing pill; when missing, offers a
// masked input + Save that PUTs the value to /api/vault/secrets/:name. On success it
// calls onSaved so the drawer re-reads vault status and re-evaluates the install gate.

function SecretRow({ name, configured, onSaved }: {
  name: string;
  configured: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue(''); // don't keep the secret in component state after a successful save
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save secret');
    } finally {
      setBusy(false);
    }
  }, [name, value, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status-pill ${configured ? 'confirmed' : 'blocked'}`}>
          {configured ? 'configured' : 'missing'}
        </span>
        <code style={{ fontSize: 13 }}>{name}</code>
      </div>
      {!configured && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            autoComplete="off"
            value={value}
            placeholder={`Enter ${name}`}
            onChange={e => setValue(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || value.length === 0}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      )}
      {err && <p className="autonomy-error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────────

function RegistryDrawer({ entry, kindPath, onClose, onChanged }: {
  entry: RegistryEntry;
  kindPath: 'skills' | 'agents';
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // PR2 (#939): required-secrets gate. Only skills declare install.requires_secrets.
  const required = entry.kind === 'skill' ? (entry.metadata?.requiresSecrets ?? []) : [];
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [secretsErr, setSecretsErr] = useState<string | null>(null);

  // Read which vault keys are configured so we can show per-secret status and gate the
  // install/enable actions. Fail closed: if the status read fails we treat everything as
  // unconfigured (the gate stays on) rather than letting an install slip through.
  const loadVaultStatus = useCallback(async () => {
    if (required.length === 0) return;
    try {
      const res = await apiFetch('/api/vault/status');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { configured_keys?: string[] };
      setConfigured(new Set(data.configured_keys ?? []));
      setSecretsErr(null);
    } catch (e) {
      setConfigured(new Set());
      setSecretsErr(e instanceof Error ? e.message : 'Failed to load secret status');
    }
  }, [required.length]);

  useEffect(() => { void loadVaultStatus(); }, [loadVaultStatus]);

  const missingSecrets = required.filter(s => !configured.has(s));
  // Block install/enable while any required secret is unconfigured — mirrors the
  // service-level gate so the UI never offers an action the backend will reject.
  const secretsBlock = missingSecrets.length > 0;
  const secretsBlockTitle = secretsBlock
    ? `Configure required secret(s) first: ${missingSecrets.join(', ')}`
    : undefined;

  // Perform a mutating API call on the entry and refresh the list on success.
  const act = useCallback(async (method: 'POST' | 'DELETE', suffix: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(
        `/api/registry/${kindPath}/${encodeURIComponent(entry.name)}${suffix}`,
        { method },
      );
      if (!res.ok) throw new Error(await errorMessage(res));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [entry.name, kindPath, onChanged]);

  const confirmUninstall = () => {
    if (window.confirm(`Uninstall "${entry.name}"? This removes its registry row.`)) {
      void act('DELETE', '');
    }
  };

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span>{entry.kind}</span>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{entry.name}</h2>
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          <p className="settings-page-sub" style={{ margin: 0 }}>
            Enabling or disabling takes effect on the next restart.
          </p>

          {entry.manifestError && (
            <p className="autonomy-error">Manifest error: {entry.manifestError}</p>
          )}
          {err && <p className="autonomy-error">{err}</p>}

          <div className="form-field">
            <label>State</label>
            <span className={`status-pill ${STATE_PILL[entry.state]}`}>{entry.state}</span>
          </div>

          {entry.metadata && (
            <>
              <div className="form-field">
                <label>Description</label>
                <div>{entry.metadata.description}</div>
              </div>
              <div className="form-field">
                <label>Version</label>
                <div>{entry.metadata.version}</div>
              </div>
              {entry.kind === 'skill' && (
                <div className="form-field">
                  <label>Action risk</label>
                  <div>{String(entry.metadata.actionRisk ?? '—')}</div>
                </div>
              )}
              {entry.kind === 'agent' && (
                <div className="form-field">
                  <label>Role / model</label>
                  <div>{entry.metadata.role ?? '—'} / {entry.metadata.modelTier ?? '—'}</div>
                </div>
              )}
              {entry.metadata.capabilities && (
                <div className="form-field">
                  <label>Capabilities</label>
                  <div>{entry.metadata.capabilities.join(', ') || '—'}</div>
                </div>
              )}
            </>
          )}

          {required.length > 0 && (
            <div className="form-field">
              <label>Required secrets</label>
              {secretsErr && <p className="autonomy-error" style={{ margin: 0 }}>{secretsErr}</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {required.map(name => (
                  <SecretRow
                    key={name}
                    name={name}
                    configured={configured.has(name)}
                    onSaved={() => { void loadVaultStatus(); }}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="form-field">
            <label>Installed</label>
            <div>
              {entry.installedAt
                ? `${entry.installedAt} by ${entry.installedBy}`
                : '—'}
            </div>
          </div>
          <div className="form-field">
            <label>Enabled</label>
            <div>
              {entry.enabledAt
                ? `${entry.enabledAt} by ${entry.enabledBy}`
                : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        {/* Install actions — only shown when not yet in the registry */}
        {entry.state === 'uninstalled' && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || secretsBlock}
              title={secretsBlockTitle}
              onClick={() => void act('POST', '/install')}
            >
              Install
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || secretsBlock}
              title={secretsBlockTitle}
              onClick={() => void act('POST', '/install-enable')}
            >
              Install &amp; enable
            </button>
          </>
        )}

        {/* Enable — only for installed (but not yet enabled) entries */}
        {entry.state === 'installed' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || secretsBlock}
            title={secretsBlockTitle}
            onClick={() => void act('POST', '/enable')}
          >
            Enable
          </button>
        )}

        {/* Disable — only for currently-enabled entries */}
        {entry.state === 'enabled' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void act('POST', '/disable')}
          >
            Disable
          </button>
        )}

        {/* Uninstall — available for any entry that has a registry row */}
        {entry.state !== 'uninstalled' && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={confirmUninstall}
          >
            Uninstall
          </button>
        )}
      </div>
    </aside>
  );
}

// ── Section (table + drawer) ─────────────────────────────────────────────────

function RegistrySection({ kind }: { kind: 'skill' | 'agent' }) {
  const kindPath = kind === 'skill' ? 'skills' : 'agents';
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [selected, setSelected] = useState<RegistryEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/registry/${kindPath}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as Record<string, RegistryEntry[]>;
      const list = data[kindPath] ?? [];
      setEntries(list);
      setLoadError(null); // clear any prior error on successful reload
      // Keep the drawer in sync with the freshly-loaded state so action
      // buttons reflect the true current state after a transition.
      setSelected(prev =>
        prev ? list.find(e => e.name === prev.name) ?? null : null,
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [kindPath]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">
          {kind === 'skill' ? 'Skills' : 'Agents'}
        </h2>
        <p className="settings-page-sub">
          Install, enable, and disable {kind === 'skill' ? 'skills' : 'agents'}.
          Changes take effect on the next restart.
        </p>
      </div>

      {loadError && <p className="autonomy-error">{loadError}</p>}

      <div className="records-layout">
        <div className="records-table-wrap">
          <table className="records-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr
                  key={e.name}
                  className={selected?.name === e.name ? 'active' : undefined}
                  onClick={() => setSelected(e)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Warn icon if the manifest failed to parse */}
                  <td>{e.name}{e.manifestError ? ' ⚠' : ''}</td>
                  <td>
                    <span className={`status-pill ${STATE_PILL[e.state]}`}>
                      {/* Extra warning on ghost: manifest is gone but DB row lingers */}
                      {e.state}{e.state === 'ghost' ? ' ⚠' : ''}
                    </span>
                  </td>
                  <td>{e.metadata?.version ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <RegistryDrawer
            key={selected.name}
            entry={selected}
            kindPath={kindPath}
            onClose={() => setSelected(null)}
            onChanged={() => { void load(); }}
          />
        )}
      </div>
    </>
  );
}

// ── Exported page components (one per child route) ───────────────────────────

export function SkillsPage() {
  return (
    <SettingsLayout activeSection="skills">
      <RegistrySection kind="skill" />
    </SettingsLayout>
  );
}

export function AgentsPage() {
  return (
    <SettingsLayout activeSection="agents">
      <RegistrySection kind="agent" />
    </SettingsLayout>
  );
}
