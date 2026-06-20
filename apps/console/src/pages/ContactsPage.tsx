import { useState, useEffect, useMemo, useCallback } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import { buildContactViewFields, kgNodeHref, formatDateTime } from './contacts-utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type ContactTier = 'blocked' | 'unknown' | 'known' | 'trusted' | 'principal';
type ContactKind = 'person' | 'organization' | 'automated' | 'principal' | 'agent';
type SystemRole = 'principal' | 'agent' | 'system' | null;
type IdentityStatus = 'active' | 'defunct' | 'bounced';

// Which drawer (if any) is open. `view` is read-only; `edit`/`create` show the
// editable form. Splitting view from edit means a single row click can never
// mutate data (#1069).
type DrawerMode = 'view' | 'edit' | 'create' | null;

// A contact's linked channel identity, as serialized by
// GET /api/kg/contacts/:id/identities (Date fields are ISO strings here).
interface ContactIdentity {
  id: string;
  contactId: string;
  channel: string;
  channelIdentifier: string;
  label: string | null;
  verified: boolean;
  verifiedAt: string | null;
  status: IdentityStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
}

// Numeric rank for tier-aware sorting (ascending capability).
const TIER_ORDER: Record<ContactTier, number> = {
  blocked: 0, unknown: 1, known: 2, trusted: 3, principal: 4,
};

interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  // Capability axis (migration 055). The legacy status/trust_level fields were removed in #955.
  tier: ContactTier;
  kind: ContactKind;
  systemRole: SystemRole;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // Canonical fields (migration 048)
  preferredName: string | null;
  title: string | null;
  organization: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedinUrl: string | null;
  bio: string | null;
  birthday: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(' ').map(s => s[0] ?? '').slice(0, 2).join('').toUpperCase();
}

function formatDate(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// ── Pagination component ──────────────────────────────────────────────────────

interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}

function Pagination({ total, page, pageSize, totalPages, onPage, onPageSize }: PaginationProps) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  // @TODO: cap at 7 buttons with ellipsis when totalPages grows large.
  const pages: number[] = [];
  for (let i = 1; i <= totalPages; i++) pages.push(i);

  return (
    <div className="records-pagination">
      <div className="records-pagination-info">
        Showing <strong style={{ color: 'var(--app-fg)' }}>{start}–{end}</strong> of {total}
      </div>
      <div className="records-page-size">
        Rows
        <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          <option value="10">10</option>
          <option value="25">25</option>
          <option value="50">50</option>
        </select>
      </div>
      <div className="records-pagination-controls">
        <button className="records-page-btn" onClick={() => onPage(page - 1)} disabled={page <= 1}>‹</button>
        {pages.map(p => (
          <button key={p} className={`records-page-btn${p === page ? ' active' : ''}`} onClick={() => onPage(p)}>{p}</button>
        ))}
        <button className="records-page-btn" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>›</button>
      </div>
    </div>
  );
}

// ── Edit / Create drawer ──────────────────────────────────────────────────────

interface DrawerProps {
  contact: Contact | null;
  creating: boolean;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
  onDeleted: (id: string) => void;
}

interface AuthOverride {
  permission: string;
  granted: boolean;
}

function ContactEditDrawer({ contact, creating, onClose, onSaved, onDeleted }: DrawerProps) {
  const [displayName, setDisplayName] = useState(contact?.displayName ?? '');
  const [role, setRole] = useState(contact?.role ?? '');
  const [tier, setTier] = useState<ContactTier>(contact?.tier ?? 'unknown');
  const [kind, setKind] = useState<ContactKind>(contact?.kind ?? 'person');
  const [kgNodeId, setKgNodeId] = useState(contact?.kgNodeId ?? '');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [preferredName, setPreferredName] = useState(contact?.preferredName ?? '');
  const [pronouns, setPronouns] = useState(contact?.pronouns ?? '');
  const [title, setTitle] = useState(contact?.title ?? '');
  const [organization, setOrganization] = useState(contact?.organization ?? '');
  const [primaryEmail, setPrimaryEmail] = useState(contact?.primaryEmail ?? '');
  const [primaryPhone, setPrimaryPhone] = useState(contact?.primaryPhone ?? '');
  const [timezone, setTimezone] = useState(contact?.timezone ?? '');
  const [locale, setLocale] = useState(contact?.locale ?? '');
  const [location, setLocation] = useState(contact?.location ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(contact?.linkedinUrl ?? '');
  const [bio, setBio] = useState(contact?.bio ?? '');
  const [birthday, setBirthday] = useState(contact?.birthday ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth overrides state
  const [overrides, setOverrides] = useState<AuthOverride[]>([]);
  const [overridesError, setOverridesError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    if (!contact || creating) return;
    setOverridesError(null);
    apiFetch(`/api/kg/contacts/${contact.id}/overrides`)
      .then(async res => {
        if (!res.ok) { setOverridesError('Failed to load permissions'); return; }
        const d = await res.json() as { overrides: AuthOverride[] };
        setOverridesError(null);
        setOverrides(d.overrides);
      })
      .catch((_err: unknown) => setOverridesError('Failed to load permissions'));
  }, [contact, creating]);

  async function handleRevokeOverride(permission: string) {
    if (!contact) return;
    setRevoking(permission);
    try {
      const res = await apiFetch(`/api/kg/contacts/${contact.id}/overrides/${permission}`, { method: 'DELETE' });
      if (!res.ok) { setOverridesError('Failed to revoke permission'); return; }
      setOverrides(prev => prev.filter(o => o.permission !== permission));
    } catch (_err: unknown) {
      setOverridesError('Failed to revoke permission');
    } finally {
      setRevoking(null);
    }
  }

  async function handleSave() {
    if (!displayName.trim()) {
      setError('Display name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        displayName: displayName.trim(),
        role: role.trim() || null,
        notes: notes.trim() || null,
        kgNodeId: kgNodeId.trim() || null,
        // Canonical fields
        preferredName: preferredName.trim() || null,
        pronouns: pronouns.trim() || null,
        title: title.trim() || null,
        organization: organization.trim() || null,
        primaryEmail: primaryEmail.trim() || null,
        primaryPhone: primaryPhone.trim() || null,
        timezone: timezone.trim() || null,
        locale: locale.trim() || null,
        location: location.trim() || null,
        linkedinUrl: linkedinUrl.trim() || null,
        bio: bio.trim() || null,
        birthday: birthday.trim() || null,
      };
      // Tier is user-settable for all contacts except the principal (whose tier is structural).
      // Kind is user-settable only for non-system contacts; principal and agent contacts have
      // structural kinds ('principal' and 'agent') that the API rejects as invalid values.
      if (creating || contact?.systemRole !== 'principal') {
        body.tier = tier;
      }
      if (creating || (contact?.systemRole !== 'principal' && contact?.systemRole !== 'agent')) {
        body.kind = kind;
      }

      let res: Response;
      if (creating) {
        res = await apiFetch('/api/kg/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await apiFetch(`/api/kg/contacts/${contact!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }

      const data = await res.json() as { contact: Contact };
      onSaved(data.contact);
    } catch (err) {
      console.error('[ContactEditDrawer] save failed:', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!contact) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/kg/contacts/${contact.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      onDeleted(contact.id);
    } catch (err) {
      console.error('[ContactEditDrawer] delete failed:', err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-person">contact</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{creating ? 'New contact' : (contact?.displayName ?? '')}</h2>
        {!creating && contact && (
          <div className="drawer-subtitle">{[contact.title, contact.organization].filter(Boolean).join(' · ')}</div>
        )}
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          {error && <p style={{ color: 'var(--app-destructive)', margin: 0, fontSize: 13 }}>{error}</p>}

          {/* Section: Identity */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '0 0 6px' }}>Identity</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-name">Display name</label>
              <input id="cf-name" type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-preferred-name">Preferred name</label>
              <input id="cf-preferred-name" type="text" value={preferredName} onChange={e => setPreferredName(e.target.value)} placeholder="Nickname or short form" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-pronouns">Pronouns</label>
              <input id="cf-pronouns" type="text" value={pronouns} onChange={e => setPronouns(e.target.value)} placeholder="they/them" />
            </div>
          </div>

          {/* Section: Work */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Work</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-role">Role</label>
              <input id="cf-role" type="text" value={role} onChange={e => setRole(e.target.value)} placeholder="Internal role label" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-title">Title</label>
              <input id="cf-title" type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Current job title" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-org">Organization</label>
              <input id="cf-org" type="text" value={organization} onChange={e => setOrganization(e.target.value)} placeholder="Employer" />
            </div>
          </div>

          {/* Section: Contact info */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Contact info</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-email">Primary email</label>
              <input id="cf-email" type="text" value={primaryEmail} onChange={e => setPrimaryEmail(e.target.value)} placeholder="Lowercased on save" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-phone">Primary phone</label>
              <input id="cf-phone" type="text" value={primaryPhone} onChange={e => setPrimaryPhone(e.target.value)} placeholder="+1 555 000 0000" />
            </div>
          </div>

          {/* Section: Location & locale */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Location &amp; locale</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-tz">Timezone</label>
              <input id="cf-tz" type="text" value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="America/New_York" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-locale">Locale</label>
              <input id="cf-locale" type="text" value={locale} onChange={e => setLocale(e.target.value)} placeholder="en-US" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-location">Location</label>
              <input id="cf-location" type="text" value={location} onChange={e => setLocation(e.target.value)} placeholder="City, region" />
            </div>
          </div>

          {/* Section: Links & bio */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Links &amp; bio</p>
          <div className="form-field">
            <label htmlFor="cf-linkedin">LinkedIn URL</label>
            <input id="cf-linkedin" type="text" value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/in/…" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-bio">Bio</label>
            <textarea id="cf-bio" rows={3} maxLength={500} value={bio} onChange={e => setBio(e.target.value)} placeholder="Short narrative (max 500 chars)" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-birthday">Birthday</label>
            <input id="cf-birthday" type="text" value={birthday} onChange={e => setBirthday(e.target.value)} placeholder="YYYY-MM-DD or --MM-DD" />
          </div>

          {/* Section: System */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>System</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-tier">Tier</label>
              <select
                id="cf-tier"
                value={tier}
                onChange={e => setTier(e.target.value as ContactTier)}
                disabled={contact?.systemRole === 'principal'}
                title={contact?.systemRole === 'principal' ? 'The principal contact\'s tier is fixed' : undefined}
              >
                <option value="blocked">Blocked</option>
                <option value="unknown">Unknown</option>
                <option value="known">Known</option>
                <option value="trusted">Trusted</option>
                {contact?.systemRole === 'principal' && <option value="principal">Principal</option>}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="cf-kind">Kind</label>
              <select
                id="cf-kind"
                value={kind}
                onChange={e => setKind(e.target.value as ContactKind)}
                disabled={contact?.systemRole === 'principal' || contact?.systemRole === 'agent'}
                title={contact?.systemRole ? 'System contacts\' kind is fixed' : undefined}
              >
                <option value="person">Person</option>
                <option value="organization">Organization</option>
                <option value="automated">Automated</option>
                {contact?.systemRole === 'principal' && <option value="principal">Principal</option>}
                {contact?.systemRole === 'agent' && <option value="agent">Agent</option>}
              </select>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="cf-kg">KG node ID</label>
            <input id="cf-kg" type="text" value={kgNodeId} onChange={e => setKgNodeId(e.target.value)} placeholder="UUID — optional" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-notes">Notes</label>
            <textarea id="cf-notes" rows={4} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

          {/* Section: Permission grants */}
          {!creating && (
            <>
              <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Permission grants</p>
              {overridesError && <p style={{ color: 'var(--app-destructive)', fontSize: 12, margin: 0 }}>{overridesError}</p>}
              {overrides.length === 0 && !overridesError && (
                <p style={{ color: 'var(--app-fg-muted)', fontSize: 12, margin: 0 }}>No explicit grants or denials on file.</p>
              )}
              {overrides.map(o => (
                <div key={o.permission} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4 }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                    background: o.granted ? 'var(--app-success, #22c55e)' : 'var(--app-destructive)',
                  }} />
                  <span style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{o.permission}</span>
                  <span style={{ color: 'var(--app-fg-muted)', fontSize: 12 }}>{o.granted ? 'granted' : 'denied'}</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => void handleRevokeOverride(o.permission)}
                    disabled={revoking === o.permission}
                  >
                    {revoking === o.permission ? '…' : 'Revoke'}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="drawer-footer">
        {!creating && (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => void handleDelete()}
            disabled={deleting || contact?.systemRole !== null && contact?.systemRole !== undefined}
            title={contact?.systemRole ? 'System contacts cannot be deleted' : undefined}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving…' : creating ? 'Create' : 'Save changes'}
        </button>
      </div>
    </aside>
  );
}

// ── Read-only view drawer ───────────────────────────────────────────────────────

interface ViewDrawerProps {
  contact: Contact;
  onClose: () => void;
  onEdit: () => void;
}

// Render a single field value with the right affordance: email → mailto:,
// phone → tel:, LinkedIn → external link, KG node → /kg deep link, else plain.
function ViewFieldValue({ kind, value }: { kind: string; value: string }) {
  switch (kind) {
    case 'email':
      return <a href={`mailto:${value}`}>{value}</a>;
    case 'phone':
      return <a href={`tel:${value}`}>{value}</a>;
    case 'url':
      return <a href={value} target="_blank" rel="noreferrer noopener">{value}</a>;
    case 'kg':
      return <a href={kgNodeHref(value)} title="Open in knowledge graph">{value}</a>;
    default:
      return <span style={{ whiteSpace: 'pre-wrap' }}>{value}</span>;
  }
}

function ContactViewDrawer({ contact, onClose, onEdit }: ViewDrawerProps) {
  const [identities, setIdentities] = useState<ContactIdentity[]>([]);
  const [identitiesError, setIdentitiesError] = useState<string | null>(null);
  const [identitiesLoaded, setIdentitiesLoaded] = useState(false);

  // Permission grants for read-only display. Reuses the existing overrides endpoint.
  const [overrides, setOverrides] = useState<AuthOverride[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Reset before fetching. The parent keys this drawer by contact id, so it
    // already remounts (fresh state) when you switch contacts — but clearing
    // here keeps the effect self-contained so stale identities can never render
    // even if that key is removed later. Also clear on failure for the same reason.
    setIdentities([]);
    setIdentitiesLoaded(false);
    setIdentitiesError(null);
    apiFetch(`/api/kg/contacts/${contact.id}/identities`)
      .then(async res => {
        if (cancelled) return;
        if (!res.ok) { setIdentities([]); setIdentitiesError('Failed to load identities'); return; }
        const d = await res.json() as { identities: ContactIdentity[] };
        setIdentities(d.identities);
      })
      .catch((_err: unknown) => { if (!cancelled) { setIdentities([]); setIdentitiesError('Failed to load identities'); } })
      .finally(() => { if (!cancelled) setIdentitiesLoaded(true); });
    return () => { cancelled = true; };
  }, [contact.id]);

  useEffect(() => {
    let cancelled = false;
    setOverrides([]);
    apiFetch(`/api/kg/contacts/${contact.id}/overrides`)
      .then(async res => {
        if (cancelled) return;
        if (!res.ok) { setOverrides([]); return; }
        const d = await res.json() as { overrides: AuthOverride[] };
        setOverrides(d.overrides);
      })
      // Grants are supplementary read-only display; a failure here just hides the
      // section (guarded by overrides.length) rather than blocking the view. Leave
      // a breadcrumb so a genuinely-broken overrides endpoint is still diagnosable.
      .catch((err: unknown) => { if (!cancelled) setOverrides([]); console.error('[ContactViewDrawer] failed to load overrides:', err); });
    return () => { cancelled = true; };
  }, [contact.id]);

  const fields = buildContactViewFields(contact);

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-person">contact</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{contact.displayName}</h2>
        {[contact.title, contact.organization].filter(Boolean).length > 0 && (
          <div className="drawer-subtitle">{[contact.title, contact.organization].filter(Boolean).join(' · ')}</div>
        )}
      </div>

      <div className="drawer-body">
        <div className="view-drawer">
          {/* Populated profile fields only — no blank rows. */}
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', gap: '6px 16px', margin: 0, fontSize: 13 }}>
            {fields.map(f => (
              <div key={f.key} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--app-fg-muted)' }}>{f.label}</dt>
                <dd style={{ margin: 0, wordBreak: 'break-word' }}>
                  <ViewFieldValue kind={f.kind} value={f.value} />
                </dd>
              </div>
            ))}
          </dl>

          {/* Channel identities — the addresses Curia actually has on file. */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '20px 0 6px' }}>Channel identities</p>
          {identitiesError && <p style={{ color: 'var(--app-destructive)', fontSize: 12, margin: 0 }}>{identitiesError}</p>}
          {!identitiesError && identitiesLoaded && identities.length === 0 && (
            <p style={{ color: 'var(--app-fg-muted)', fontSize: 12, margin: 0 }}>No channel identities on file.</p>
          )}
          {identities.map(idn => (
            <div key={idn.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--app-fg-muted)', textTransform: 'uppercase', minWidth: 48 }}>{idn.channel}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{idn.channelIdentifier}</span>
              {idn.label && <span style={{ color: 'var(--app-fg-muted)', fontSize: 12 }}>({idn.label})</span>}
              <span style={{ fontSize: 11, color: idn.verified ? 'var(--app-success, #22c55e)' : 'var(--app-fg-muted)' }}>
                {idn.verified ? 'verified' : 'unverified'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--app-fg-muted)' }}>· {idn.status}</span>
            </div>
          ))}

          {/* Permission grants — read-only here; managed in the Edit drawer. */}
          {overrides.length > 0 && (
            <>
              <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '20px 0 6px' }}>Permission grants</p>
              {overrides.map(o => (
                <div key={o.permission} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4 }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                    background: o.granted ? 'var(--app-success, #22c55e)' : 'var(--app-destructive)',
                  }} />
                  <span style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{o.permission}</span>
                  <span style={{ color: 'var(--app-fg-muted)', fontSize: 12 }}>{o.granted ? 'granted' : 'denied'}</span>
                </div>
              ))}
            </>
          )}

          {/* Timestamps */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '20px 0 6px' }}>Record</p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', gap: '6px 16px', margin: 0, fontSize: 13 }}>
            <dt style={{ color: 'var(--app-fg-muted)' }}>Created</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(contact.createdAt)}</dd>
            <dt style={{ color: 'var(--app-fg-muted)' }}>Updated</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(contact.updatedAt)}</dd>
          </dl>
        </div>
      </div>

      <div className="drawer-footer">
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        <button className="btn btn-primary btn-sm" onClick={onEdit}>Edit</button>
      </div>
    </aside>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Default to the list you actually work from — Known people — rather than the
  // full pile of every tier/kind. Chips still let you widen to All (#1069).
  const [tierFilter, setTierFilter] = useState<'all' | ContactTier>('known');
  const [kindFilter, setKindFilter] = useState<'all' | ContactKind>('person');
  const [sort, setSort] = useState<{ key: keyof Contact; dir: 'asc' | 'desc' }>({ key: 'tier', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // Selected contact + which drawer is open. `view` opens on a single row click
  // (read-only); `edit`/`create` show the editable form (#1069).
  const [selected, setSelected] = useState<Contact | null>(null);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/kg/contacts');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { contacts: Contact[] };
      setContacts(data.contacts);
    } catch (err) {
      console.error('[ContactsPage] failed to load contacts:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load contacts');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    allTiers:     contacts.length,
    blocked:      contacts.filter(c => c.tier === 'blocked').length,
    unknown:      contacts.filter(c => c.tier === 'unknown').length,
    known:        contacts.filter(c => c.tier === 'known').length,
    trusted:      contacts.filter(c => c.tier === 'trusted').length,
    principal:    contacts.filter(c => c.tier === 'principal').length,
    allKinds:     contacts.length,
    person:       contacts.filter(c => c.kind === 'person').length,
    organization: contacts.filter(c => c.kind === 'organization').length,
    automated:    contacts.filter(c => c.kind === 'automated').length,
  }), [contacts]);

  const filtered = useMemo(() => {
    let rows = contacts;
    if (tierFilter !== 'all') rows = rows.filter(c => c.tier === tierFilter);
    if (kindFilter !== 'all') rows = rows.filter(c => c.kind === kindFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(c =>
        (c.displayName + ' ' + (c.title ?? '') + ' ' + (c.organization ?? '') + ' ' + (c.role ?? '')).toLowerCase().includes(q)
      );
    }
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      if (sort.key === 'tier') {
        return ((TIER_ORDER[a.tier] ?? 0) - (TIER_ORDER[b.tier] ?? 0)) * dir;
      }
      const av = (a[sort.key] ?? '') as string;
      const bv = (b[sort.key] ?? '') as string;
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
    return rows;
  }, [contacts, tierFilter, kindFilter, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function toggleSort(key: keyof Contact) {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }
  const sortArrow = (key: keyof Contact) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';

  function handleSaved(contact: Contact) {
    setContacts(prev => {
      const idx = prev.findIndex(c => c.id === contact.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = contact;
        return next;
      }
      // New contact: widen filters so it's immediately visible regardless of its
      // tier/kind (defaults are Known + Person).
      setTierFilter(contact.tier);
      if (contact.kind === 'person' || contact.kind === 'organization' || contact.kind === 'automated') {
        setKindFilter(contact.kind);
      } else {
        setKindFilter('all');
      }
      return [...prev, contact];
    });
    // After a save, return to the read-only view showing the saved data.
    setSelected(contact);
    setDrawerMode('view');
  }

  function handleDeleted(id: string) {
    setContacts(prev => prev.filter(c => c.id !== id));
    setSelected(null);
    setDrawerMode(null);
  }

  function openView(contact: Contact) {
    setSelected(contact);
    setDrawerMode('view');
  }

  function openEdit(contact: Contact) {
    setSelected(contact);
    setDrawerMode('edit');
  }

  function closeDrawer() {
    setSelected(null);
    setDrawerMode(null);
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="contacts" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Contacts">
            <TopbarSearch
              placeholder="Search name, title or org…"
              value={search}
              onChange={v => { setSearch(v); setPage(1); }}
            />
            <TopbarDivider />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setSelected(null); setDrawerMode('create'); }}
            >
              + New contact
            </button>
          </Topbar>

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              {/* Mobile search — TopbarSearch is hidden below 768px by the shared stylesheet */}
              <div className="contacts-mobile-search">
                <input
                  type="text"
                  placeholder="Search name, title or org…"
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                />
              </div>

              <div className="records-toolbar">
                <div className="records-toolbar-left">
                  {([['all', 'All', counts.allTiers], ['blocked', 'Blocked', counts.blocked], ['unknown', 'Unknown', counts.unknown], ['known', 'Known', counts.known], ['trusted', 'Trusted', counts.trusted]] as const).map(([v, label, count]) => (
                    <button
                      key={v}
                      className={`records-filter-chip${tierFilter === v ? ' active' : ''}`}
                      onClick={() => { setTierFilter(v); setPage(1); }}
                    >
                      {label}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {count}
                      </span>
                    </button>
                  ))}
                  <span style={{ borderLeft: '1px solid var(--app-border)', margin: '0 4px', height: 16, display: 'inline-block', verticalAlign: 'middle' }} />
                  {([['all', 'All kinds', counts.allKinds], ['person', 'Person', counts.person], ['organization', 'Org', counts.organization], ['automated', 'Auto', counts.automated]] as const).map(([v, label, count]) => (
                    <button
                      key={v}
                      className={`records-filter-chip${kindFilter === v ? ' active' : ''}`}
                      onClick={() => { setKindFilter(v); setPage(1); }}
                    >
                      {label}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {count}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="records-toolbar-right">
                  <span className="topbar-meta">{filtered.length} of {contacts.length}</span>
                </div>
              </div>

              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th className="sortable" aria-sort={sort.key === 'displayName' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('displayName')}>
                              Name <span className="sort-arrow">{sortArrow('displayName')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'title' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('title')}>
                              Title <span className="sort-arrow">{sortArrow('title')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'organization' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('organization')}>
                              Org <span className="sort-arrow">{sortArrow('organization')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'tier' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('tier')}>
                              Tier <span className="sort-arrow">{sortArrow('tier')}</span>
                            </button>
                          </th>
                          <th>Kind</th>
                          <th className="sortable col-updated" aria-sort={sort.key === 'updatedAt' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('updatedAt')}>
                              Updated <span className="sort-arrow">{sortArrow('updatedAt')}</span>
                            </button>
                          </th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map(c => (
                          <tr
                            key={c.id}
                            className={selected?.id === c.id ? 'active' : ''}
                            onClick={() => openView(c)}
                          >
                            <td>
                              <div className="cell-with-avatar">
                                <span className="avatar-sm">{initials(c.displayName)}</span>
                                <span className="cell-primary">{c.displayName}</span>
                                {c.systemRole === 'principal' && (
                                  <span className="system-role-badge system-role-principal">Principal</span>
                                )}
                                {c.systemRole === 'agent' && (
                                  <span className="system-role-badge system-role-agent">Agent</span>
                                )}
                              </div>
                            </td>
                            <td>{c.title ?? ''}</td>
                            <td>{c.organization ?? ''}</td>
                            <td><span className={`status-pill tier-${c.tier}`}>{c.tier}</span></td>
                            <td style={{ fontSize: 12, color: 'var(--app-fg-muted)' }}>{c.kind}</td>
                            <td className="cell-mono col-updated">{formatDate(c.updatedAt)}</td>
                            <td>
                              <div className="cell-actions" onClick={e => e.stopPropagation()}>
                                {/* KG deep-link — only when this contact is linked to a node. */}
                                {c.kgNodeId && (
                                  <a
                                    className="btn-icon"
                                    href={kgNodeHref(c.kgNodeId)}
                                    title="Open in knowledge graph"
                                    aria-label="Open in knowledge graph"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <circle cx="5" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="11.5" cy="18" r="2.5"/>
                                      <path d="M7 7.5 10 16M16.5 7.5 13 16"/>
                                    </svg>
                                  </a>
                                )}
                                <button
                                  className="btn-icon"
                                  title="Edit"
                                  onClick={() => openEdit(c)}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                                  </svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {pageRows.length === 0 && (
                          <tr>
                            <td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No contacts match.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    total={filtered.length}
                    page={safePage}
                    pageSize={pageSize}
                    totalPages={totalPages}
                    onPage={setPage}
                    onPageSize={n => { setPageSize(n); setPage(1); }}
                  />
                </div>

                {drawerMode === 'view' && selected && (
                  <ContactViewDrawer
                    key={`view-${selected.id}`}
                    contact={selected}
                    onClose={closeDrawer}
                    onEdit={() => setDrawerMode('edit')}
                  />
                )}
                {(drawerMode === 'edit' || drawerMode === 'create') && (
                  <ContactEditDrawer
                    key={drawerMode === 'edit' ? selected?.id ?? 'edit' : 'new'}
                    contact={drawerMode === 'edit' ? selected : null}
                    creating={drawerMode === 'create'}
                    onClose={closeDrawer}
                    onSaved={handleSaved}
                    onDeleted={handleDeleted}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
