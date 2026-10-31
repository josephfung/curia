import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch } from '../api';
import { endConsoleSession } from '../auth/log-out.js';
import { timeAgo } from '../components/settings/ConfigHistory';
import { SettingsLayout } from './SettingsPage';

interface DeviceSession {
  id: string;
  kind: 'browser' | 'paired_device';
  name: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  notificationsEnabled: boolean;
}

function isDeviceSession(value: unknown): value is DeviceSession {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && (row['kind'] === 'browser' || row['kind'] === 'paired_device')
    && (row['name'] === null || typeof row['name'] === 'string')
    && typeof row['createdAt'] === 'string'
    && typeof row['lastSeenAt'] === 'string'
    && typeof row['current'] === 'boolean'
    && typeof row['notificationsEnabled'] === 'boolean';
}

function deviceLabel(device: DeviceSession): string {
  return device.name && device.name.trim().length > 0 ? device.name : 'Unnamed device';
}

function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function kindLabel(kind: DeviceSession['kind']): string {
  return kind === 'paired_device' ? 'Paired phone' : 'Browser';
}

export default function DevicesSettingsPage() {
  return (
    <SettingsLayout activeSection="devices">
      <DevicesSection />
    </SettingsLayout>
  );
}

function DevicesSection() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch('/api/sessions');
    if (res.status === 401) {
      await navigate({ to: '/login' });
      return;
    }
    if (!res.ok) throw new Error(`Could not load devices (${res.status})`);
    const body = await res.json() as { sessions?: unknown };
    if (!Array.isArray(body.sessions) || !body.sessions.every(isDeviceSession)) {
      throw new Error('Malformed device list');
    }
    setDevices(body.sessions);
    setLoadError(null);
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => {
      if (cancelled) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load devices');
    });
    return () => { cancelled = true; };
  }, [load]);

  async function rename(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draftName }),
      });
      if (res.status === 401) {
        await navigate({ to: '/login' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'Could not rename the device');
      }
      setRenamingId(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not rename the device');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: DeviceSession) {
    const label = deviceLabel(device);
    const prompt = device.current
      ? `Sign out ${label}? This ends your session on this device.`
      : `Sign out ${label}?`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/sessions/${device.id}`, { method: 'DELETE' });
      if (res.status === 401) {
        await navigate({ to: '/login' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'Could not revoke the device');
      }
      const body = await res.json() as { current?: boolean };
      if (body.current) {
        await navigate({ to: '/login' });
        return;
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not revoke the device');
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers() {
    if (!window.confirm('Sign out every device except this one?')) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch('/api/sessions/revoke-others', { method: 'POST' });
      if (res.status === 401) {
        await navigate({ to: '/login' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? 'Could not sign out other devices');
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not sign out other devices');
    } finally {
      setBusy(false);
    }
  }

  async function logOut() {
    if (!window.confirm('Log out of Curia on this device?')) return;
    setBusy(true);
    setActionError(null);
    const result = await endConsoleSession();
    if (!result.ok) {
      setActionError(result.error);
      setBusy(false);
      return;
    }
    await navigate({ to: '/login' });
  }

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Devices</h2>
        <p className="settings-page-sub">
          Browsers and phones signed in to this Curia. A device stays signed in for 90 days after its last use. Signing it out here ends that session immediately.
        </p>
      </div>

      {loadError && <p className="autonomy-error" role="alert">{loadError}</p>}
      {actionError && <p className="autonomy-error" role="alert">{actionError}</p>}

      {devices === null && !loadError && (
        <p className="settings-muted-hint">Loading…</p>
      )}

      {devices !== null && (
        <>
          <div className="device-list">
            {devices.map((device) => (
              <article key={device.id} className="device-row">
                <div className="device-row-head">
                  <span className="device-name">{deviceLabel(device)}</span>
                  {device.current && <span className="device-badge">This device</span>}
                </div>
                <p className="device-meta">
                  {kindLabel(device.kind)}
                  {' · '}
                  {device.current ? 'Active now' : `Last seen ${timeAgo(device.lastSeenAt)}`}
                  {' · Created '}
                  {formatCreated(device.createdAt)}
                  {' · '}
                  {device.notificationsEnabled ? 'Notifications on' : 'Notifications off'}
                </p>
                {renamingId === device.id ? (
                  <form
                    className="device-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void rename(device.id);
                    }}
                  >
                    <input
                      aria-label="Device name"
                      value={draftName}
                      maxLength={80}
                      onChange={(event) => setDraftName(event.target.value)}
                    />
                    <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setRenamingId(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="device-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => {
                        setDraftName(device.name ?? '');
                        setRenamingId(device.id);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => void (device.current ? logOut() : revoke(device))}
                    >
                      {device.current ? 'Log out' : 'Sign out'}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="device-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void revokeOthers()}>
              Sign out all other devices
            </button>
          </div>
        </>
      )}
    </>
  );
}
