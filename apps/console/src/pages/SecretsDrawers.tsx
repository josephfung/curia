// Right-hand drawers for the Secrets page (#2453): View (the debugging view), Edit and Create.
// No value ever reaches the console: the API returns names, dates and sign-in details only, and
// the value fields here are write-only (type="password", cleared after a save).
import { useState, useEffect, type ReactNode } from 'react';
import { apiFetch } from '../api.js';
import { formatDateTime } from './contacts-utils.js';
import {
  declarerLabel,
  errorMessage,
  lastUsedText,
  canEditValue,
  readableLabel,
  removeSecretFlow,
  secretStatus,
  siteHost,
  type SecretKind,
  type SecretRowData,
  type SecretStatus,
} from './secrets-utils.js';

// ── Shared labels ─────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<SecretKind, string> = {
  personal: 'Personal',
  system: 'System',
  platform: 'Platform',
};

export const STATUS_LABEL: Record<SecretStatus, string> = {
  configured: 'Configured',
  env: 'From env',
  missing: 'Missing',
  not_set: 'Not set',
  not_declared: 'Not declared',
};

// Reuses the existing pill tones: green set, amber env fallback, red missing, grey otherwise.
const STATUS_PILL_CLASS: Record<SecretStatus, string> = {
  configured: 'confirmed',
  env: 'provisional',
  missing: 'blocked',
  not_set: '',
  not_declared: 'cancelled',
};

export function StatusPill({ row }: { row: SecretRowData }) {
  const status = secretStatus(row);
  return <span className={`status-pill secrets-status ${STATUS_PILL_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

/** "Jun 4" this year, "Jun 4, 2025" otherwise, in the viewer's zone; "n/a" when absent. */
export function shortDate(iso: string | null, now = new Date()): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

const PLATFORM_REFUSAL = 'Managed by deployment — change it in the deploy environment, not here.';
const STRUCTURED_VALUE = 'Recapture through Curia to change a structured value.';

function secretPath(name: string): string {
  return `/api/vault/secrets/${encodeURIComponent(name)}`;
}

/** Only http(s) sign-in pages become links; anything else is shown as text. */
function safeHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    // Not a URL at all: render it as plain text rather than a broken link.
    return null;
  }
}

// ── Drawer shell ──────────────────────────────────────────────────────────────

function DrawerShell({ title, subtitle, onClose, children, footer }: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-person">secret</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{title}</h2>
        {subtitle && <div className="drawer-subtitle">{subtitle}</div>}
      </div>
      <div className="drawer-body">
        <div className="edit-drawer-form">{children}</div>
      </div>
      {footer && <div className="drawer-footer">{footer}</div>}
    </aside>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="secrets-section-label">{children}</p>;
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="secrets-facts">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'contents' }}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Who declares a system or platform key, with each declarer's purpose. */
function Declarers({ row }: { row: SecretRowData }) {
  if (row.declaredBy.length === 0) {
    return <p className="secrets-hint">Nothing declares this key any more. It may be left over from an uninstalled tool or channel.</p>;
  }
  return (
    <ul className="secrets-declarers">
      {row.declaredBy.map(d => (
        <li key={`${d.kind}:${d.name}`}>
          <span>{declarerLabel(d)}</span>
          <span className="secrets-hint"> · {d.required ? 'Required' : 'Optional'}</span>
          {d.purpose && <span className="secrets-hint secrets-block">{d.purpose}</span>}
        </li>
      ))}
    </ul>
  );
}

function EnvFallbackNote({ row }: { row: SecretRowData }) {
  if (!row.envFallback) return null;
  return (
    <p className="secrets-hint">
      Supplied by the {row.envFallback} environment variable. Setting a value here takes precedence;
      removing it here does not clear the variable.
    </p>
  );
}

// ── View ──────────────────────────────────────────────────────────────────────

interface SecretUse {
  at: string;
  agentId: string | null;
  /** '' when the read wasn't made through a tool. */
  toolName: string;
  source: string | null;
  byReference: boolean;
}

function RecentUses({ row }: { row: SecretRowData }) {
  const [uses, setUses] = useState<SecretUse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Most boot-read keys emit no secret.accessed rows, but a few are also read through
  // ctx.secret(); fetch only when a use is recorded.
  const skipFetch = row.readAtStartup && !row.lastUsedAt;

  useEffect(() => {
    if (skipFetch) return;
    let cancelled = false;
    setUses(null);
    setError(null);
    apiFetch(`${secretPath(row.name)}/uses?limit=5`)
      .then(async res => {
        if (!res.ok) throw new Error(await errorMessage(res));
        const d = await res.json() as { uses?: SecretUse[] };
        if (!cancelled) setUses(d.uses ?? []);
      })
      .catch((err: unknown) => {
        console.error('[SecretViewDrawer] failed to load recent uses:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load recent uses');
      });
    return () => { cancelled = true; };
  }, [row.name, skipFetch]);

  if (skipFetch) {
    return row.configured || row.envFallback
      ? <p className="secrets-hint">Read when Curia starts; individual reads aren't recorded.</p>
      : <p className="secrets-hint">Not set, so there is nothing to read.</p>;
  }
  if (error) return <p className="autonomy-error">{error}</p>;
  if (uses === null) return <p className="secrets-hint">Loading…</p>;
  const now = new Date();
  return (
    <>
      {uses.length === 0 ? (
        <p className="secrets-hint">Curia hasn't read this secret yet.</p>
      ) : (
        <ul className="secrets-uses">
          {uses.map((u, i) => (
            <li key={`${u.at}-${i}`}>
              {/* A null agentId is a system-initiated read (SecretUse), not missing data. */}
              <span>{u.agentId ?? 'System'} · {u.toolName || u.source || 'unknown'}</span>
              {/* Same relative wording as the Last used column. */}
              <span className="secrets-hint">{lastUsedText({ ...row, readAtStartup: false, configured: true, lastUsedAt: u.at }, now)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="secrets-hint">"Used" means Curia read it; whether the sign-in worked isn't recorded.</p>
    </>
  );
}

export function SecretViewDrawer({ row, onClose, onEdit, onRemoved }: {
  row: SecretRowData;
  onClose: () => void;
  onEdit: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two confirmations, the second only when the server says something enabled needs the key.
  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await removeSecretFlow(row.name, {
        confirm: message => window.confirm(message),
        del: force => apiFetch(`${secretPath(row.name)}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
      });
      if (outcome === 'removed') onRemoved();
    } catch (err) {
      console.error('[SecretViewDrawer] remove failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to remove secret');
    } finally {
      setBusy(false);
    }
  }

  const href = row.loginUrl ? safeHref(row.loginUrl) : null;
  let footer: ReactNode = null;
  if (row.kind === 'system' && !row.configured) {
    footer = <><div style={{ flex: 1 }} /><button className="btn btn-primary btn-sm" onClick={onEdit}>Set value</button></>;
  } else if (row.kind !== 'platform') {
    footer = (
      <>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void handleRemove()}>
          {busy ? 'Removing…' : 'Remove'}
        </button>
        <div style={{ flex: 1 }} />
        {canEditValue(row) && <button className="btn btn-primary btn-sm" disabled={busy} onClick={onEdit}>Edit</button>}
      </>
    );
  }

  return (
    <DrawerShell title={readableLabel(row.name)} subtitle={<code>{row.name}</code>} onClose={onClose} footer={footer}>
      {error && <p className="autonomy-error">{error}</p>}
      <Facts>
        <Fact label="Kind">{KIND_LABEL[row.kind]}</Fact>
        <Fact label="Status"><StatusPill row={row} /></Fact>
        {row.kind === 'personal' && (
          <>
            <Fact label="Sign-in page">
              {!row.loginUrl ? <span className="secrets-hint">No sign-in site saved</span>
                : href ? <a href={href} target="_blank" rel="noreferrer noopener">{row.loginUrl}</a>
                : row.loginUrl}
            </Fact>
            <Fact label="Username">{row.username ?? <span className="secrets-hint">None saved</span>}</Fact>
          </>
        )}
        {row.valueFormat === 'json' && <Fact label="Value">Structured value</Fact>}
        <Fact label="Created">{row.createdAt ? formatDateTime(row.createdAt) : 'n/a'}</Fact>
        <Fact label="Updated">{row.updatedAt ? formatDateTime(row.updatedAt) : 'n/a'}</Fact>
      </Facts>

      {row.kind !== 'personal' && (
        <div>
          <SectionLabel>{row.kind === 'platform' ? 'Read by' : 'Declared by'}</SectionLabel>
          <Declarers row={row} />
          <EnvFallbackNote row={row} />
          {row.kind === 'platform' && <p className="secrets-hint">{PLATFORM_REFUSAL}</p>}
        </div>
      )}

      <div>
        <SectionLabel>Recent uses</SectionLabel>
        <RecentUses row={row} />
      </div>
    </DrawerShell>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────────────

function SaveFooter({ onClose, onSave, saving, disabled }: {
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  disabled: boolean;
}) {
  return (
    <>
      <div style={{ flex: 1 }} />
      <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary btn-sm" disabled={saving || disabled} onClick={onSave}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
}

/** A sign-in detail edit: undefined when unchanged (omit), null when cleared, else the new text. */
function detailChange(input: string, current: string | undefined): string | null | undefined {
  const next = input.trim();
  if (next === (current ?? '')) return undefined;
  return next === '' ? null : next;
}

export function SecretEditDrawer({ row, onClose, onSaved }: {
  row: SecretRowData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loginUrl, setLoginUrl] = useState(row.loginUrl ?? '');
  const [username, setUsername] = useState(row.username ?? '');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const structured = row.valueFormat === 'json';
  const personal = row.kind === 'personal';

  // Personal: only what changed, null for a cleared detail, no value when New password is blank.
  const patch: { loginUrl?: string | null; username?: string | null; value?: string } = {};
  if (personal) {
    const url = detailChange(loginUrl, row.loginUrl);
    const user = detailChange(username, row.username);
    if (url !== undefined) patch.loginUrl = url;
    if (user !== undefined) patch.username = user;
    if (!structured && value.length > 0) patch.value = value;
  }
  const nothingToSave = personal ? Object.keys(patch).length === 0 : value.length === 0;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = personal
        ? await apiFetch(`/api/vault/user-secrets/${encodeURIComponent(row.name)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        : await apiFetch(secretPath(row.name), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue('');
      onSaved();
    } catch (err) {
      console.error('[SecretEditDrawer] save failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to save secret');
    } finally {
      setSaving(false);
    }
  }

  if (row.kind === 'platform') {
    return (
      <DrawerShell title={readableLabel(row.name)} subtitle={<code>{row.name}</code>} onClose={onClose}>
        <p className="secrets-hint">{PLATFORM_REFUSAL}</p>
      </DrawerShell>
    );
  }

  return (
    <DrawerShell
      title={`${row.configured ? 'Edit' : 'Set'} ${readableLabel(row.name)}`}
      onClose={onClose}
      footer={<SaveFooter onClose={onClose} onSave={() => void handleSave()} saving={saving} disabled={nothingToSave} />}
    >
      {error && <p className="autonomy-error">{error}</p>}
      <div className="form-field">
        <span className="secrets-field-label">Vault key</span>
        <code>{row.name}</code>
        <span className="secrets-hint">Can't be renamed.</span>
      </div>

      {personal ? (
        <>
          <div className="form-field">
            <label htmlFor="se-url">Sign-in page URL</label>
            <input id="se-url" type="text" inputMode="url" value={loginUrl} onChange={e => setLoginUrl(e.target.value)} placeholder="https://" />
          </div>
          <div className="form-field">
            <label htmlFor="se-user">Username</label>
            <input id="se-user" type="text" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} />
          </div>
          {structured ? (
            <p className="secrets-hint">This holds a structured value. {STRUCTURED_VALUE}</p>
          ) : (
            <div className="form-field">
              <label htmlFor="se-value">New password</label>
              <input
                id="se-value" type="password" autoComplete="new-password" value={value}
                onChange={e => setValue(e.target.value)} placeholder="Leave blank to keep the current one"
              />
            </div>
          )}
        </>
      ) : (
        <>
          <div>
            <SectionLabel>Declared by</SectionLabel>
            <Declarers row={row} />
            <EnvFallbackNote row={row} />
          </div>
          {structured ? (
            <p className="secrets-hint">This holds a structured value. {STRUCTURED_VALUE}</p>
          ) : (
            <div className="form-field">
              <label htmlFor="se-value">New value</label>
              <input
                id="se-value" type="password" autoComplete="new-password" value={value}
                onChange={e => setValue(e.target.value)} placeholder={`Enter ${row.name}`}
              />
            </div>
          )}
        </>
      )}
    </DrawerShell>
  );
}

// ── Create ────────────────────────────────────────────────────────────────────

type CreateType = 'website_login' | 'other';

interface NamePreview {
  name: string;
  existing: { updatedAt: string; valueFormat: 'string' | 'json' | null } | null;
}

const PREVIEW_DEBOUNCE_MS = 300;

export function SecretCreateDrawer({ existingRows, onClose, onSaved }: {
  existingRows: SecretRowData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<CreateType>('website_login');
  const [loginUrl, setLoginUrl] = useState('');
  const [username, setUsername] = useState('');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [preview, setPreview] = useState<NamePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The name comes from the server's naming policy, so the console and capture links can never
  // disagree. Asked again 300ms after the type, label or URL last changed.
  useEffect(() => {
    const namingInput = type === 'website_login' ? loginUrl.trim() : label.trim();
    setPreview(null);
    setPreviewError(null);
    if (namingInput === '') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const body = type === 'website_login' ? { type, loginUrl: namingInput } : { type, label: namingInput };
      apiFetch('/api/vault/user-secrets/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async res => {
          if (!res.ok) throw new Error(await errorMessage(res));
          const d = await res.json() as NamePreview;
          if (!cancelled) setPreview(d);
        })
        .catch((err: unknown) => {
          // Usually an unfinished URL while typing; shown as a hint, not an error banner.
          if (!cancelled) setPreviewError(err instanceof Error ? err.message : 'The secret could not be named.');
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [type, label, loginUrl]);

  const structuredExisting = preview?.existing?.valueFormat === 'json';
  const ready = value.length > 0 && (type === 'website_login' ? loginUrl.trim() !== '' : label.trim() !== '');

  // Audit aid: another personal secret already signs in to this site under a different name.
  const host = siteHost(loginUrl.trim());
  const sameSite = host === null ? [] : existingRows.filter(r =>
    r.kind === 'personal' && r.name !== preview?.name && siteHost(r.loginUrl) === host).map(r => r.name);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/vault/user-secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          ...(type === 'other' ? { label: label.trim() } : {}),
          ...(loginUrl.trim() ? { loginUrl: loginUrl.trim() } : {}),
          ...(username.trim() ? { username: username.trim() } : {}),
          value,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue('');
      onSaved();
    } catch (err) {
      console.error('[SecretCreateDrawer] save failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to save secret');
    } finally {
      setSaving(false);
    }
  }

  const urlField = (
    <div className="form-field">
      <label htmlFor="sc-url">Sign-in page URL</label>
      <input id="sc-url" type="text" inputMode="url" value={loginUrl} onChange={e => setLoginUrl(e.target.value)} placeholder="https://" />
    </div>
  );
  const usernameField = (
    <div className="form-field">
      <label htmlFor="sc-user">Username</label>
      <input id="sc-user" type="text" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} />
    </div>
  );
  const valueField = (fieldLabel: string) => (
    <div className="form-field">
      <label htmlFor="sc-value">{fieldLabel}</label>
      <input id="sc-value" type="password" autoComplete="new-password" value={value} onChange={e => setValue(e.target.value)} />
    </div>
  );

  return (
    <DrawerShell
      title="New secret"
      onClose={onClose}
      // No Save until the name preview is back: a save before it could replace an existing
      // secret without the replacement notice.
      footer={<SaveFooter onClose={onClose} onSave={() => void handleSave()} saving={saving} disabled={!ready || preview === null || structuredExisting} />}
    >
      {error && <p className="autonomy-error">{error}</p>}
      <div className="form-field">
        <span className="secrets-field-label">Type</span>
        <div className="dash-seg secrets-seg" role="group" aria-label="Type">
          <button type="button" className={type === 'website_login' ? 'on' : ''} aria-pressed={type === 'website_login'} onClick={() => setType('website_login')}>
            Website login
          </button>
          <button type="button" className={type === 'other' ? 'on' : ''} aria-pressed={type === 'other'} onClick={() => setType('other')}>
            Other
          </button>
          {/* A disabled button gets no hover events, so the tooltip sits on a wrapper. */}
          <span title="Coming soon — ADR-027">
            <button type="button" disabled>Card (later)</button>
          </span>
        </div>
      </div>

      {type === 'website_login' ? (
        <>
          {urlField}
          {usernameField}
          {valueField('Password')}
        </>
      ) : (
        <>
          <div className="form-field">
            <label htmlFor="sc-label">Label</label>
            <input id="sc-label" type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Bank PIN" />
          </div>
          {valueField('Value')}
          {urlField}
          {usernameField}
        </>
      )}

      {preview && (
        <p className="secrets-hint">
          Saved as <code>{preview.name}</code>{type === 'website_login' ? ' — named from the site.' : '.'}
        </p>
      )}
      {previewError && <p className="secrets-hint">{previewError}</p>}
      {preview?.existing && (
        <div className="kg-merge-callout kg-merge-callout-warn secrets-callout">
          {structuredExisting ? (
            <span>⚠ You already have <code>{preview.name}</code>, which holds a structured value. {STRUCTURED_VALUE}</span>
          ) : (
            <span>
              ⚠ You already have <code>{preview.name}</code> (updated {shortDate(preview.existing.updatedAt)}).
              {' '}Saving replaces it instead of adding a duplicate.
            </span>
          )}
        </div>
      )}
      {sameSite.length > 0 && (
        <p className="secrets-hint">⚠ Same site as {sameSite.join(', ')}.</p>
      )}
    </DrawerShell>
  );
}
