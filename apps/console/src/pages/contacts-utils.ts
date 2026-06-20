// Pure, framework-free helpers for the Contacts page View drawer (#1069).
// Kept separate from ContactsPage.tsx so they can be unit-tested in the
// node test environment (component .tsx files are not picked up by vitest).

// How a view-drawer field should be rendered. The component switches on this to
// decide whether to emit a plain value, a mailto:/tel:/external link, or a KG
// deep-link.
export type ViewFieldKind = 'text' | 'email' | 'phone' | 'url' | 'kg';

export interface ViewField {
  key: string;
  label: string;
  value: string;
  kind: ViewFieldKind;
}

// The subset of a contact the view drawer needs. ContactsPage's `Contact`
// interface is structurally compatible with this.
export interface ContactViewModel {
  tier: string;
  kind: string;
  notes: string | null;
  preferredName: string | null;
  pronouns: string | null;
  role: string | null;
  title: string | null;
  organization: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  linkedinUrl: string | null;
  bio: string | null;
  birthday: string | null;
  kgNodeId: string | null;
}

// Treat empty / whitespace-only strings as unset, so the drawer never renders a
// blank row.
function present(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Build the ordered list of populated fields to show in the read-only view.
 * Only fields with a value are returned (no blank rows). `tier` and `kind` are
 * always present on a contact, so they always appear; `notes` and the rest
 * appear only when set. Field order mirrors the Edit drawer's sections.
 */
export function buildContactViewFields(c: ContactViewModel): ViewField[] {
  const fields: ViewField[] = [];
  const push = (key: string, label: string, value: string | null | undefined, kind: ViewFieldKind = 'text') => {
    if (present(value)) fields.push({ key, label, value: value.trim(), kind });
  };

  // Identity
  push('preferredName', 'Preferred name', c.preferredName);
  push('pronouns', 'Pronouns', c.pronouns);
  // Work
  push('role', 'Role', c.role);
  push('title', 'Title', c.title);
  push('organization', 'Organization', c.organization);
  // Contact info — smart-formatted as mailto:/tel:
  push('primaryEmail', 'Primary email', c.primaryEmail, 'email');
  push('primaryPhone', 'Primary phone', c.primaryPhone, 'phone');
  // Location & locale
  push('timezone', 'Timezone', c.timezone);
  push('locale', 'Locale', c.locale);
  push('location', 'Location', c.location);
  // Links & bio
  push('linkedinUrl', 'LinkedIn', c.linkedinUrl, 'url');
  push('bio', 'Bio', c.bio);
  push('birthday', 'Birthday', c.birthday);
  // System
  push('tier', 'Tier', c.tier);
  push('kind', 'Kind', c.kind);
  push('kgNodeId', 'KG node', c.kgNodeId, 'kg');
  push('notes', 'Notes', c.notes);

  return fields;
}

/** Deep-link to a KG node in the console's /kg route, which validates `node`. */
export function kgNodeHref(nodeId: string): string {
  return `/kg?node=${encodeURIComponent(nodeId)}`;
}

/**
 * Format an ISO timestamp as a localized date + time for display. Returns the
 * raw input unchanged if it is not a parseable date, so a bad value is visible
 * rather than rendered as "Invalid Date".
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
