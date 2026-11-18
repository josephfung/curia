import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../api.js';
import { ConnectWithGoogle } from './ConnectWithGoogle.js';
// Dependency-free server module (only imports state-keys.ts), safe in the browser bundle.
import { MAILBOX_ID_RE, RESERVED_MAILBOX_IDS } from '../../../../src/principal-mailboxes/types.js';

// ── Principal mailboxes section ──────────────────────────────────────────────
//
// Rendered on Settings → Behaviour → Email & Calendar (EmailCalendarSettingsPage.tsx, #2475).
// The principal's OWN Gmail mailboxes, separate from Curia's email accounts (Channels → Email).
// readOnly (no Nylas API key yet) lists the mailboxes and turns every change control off.
// A grant ID is typed once, tested (shows the address and provider the grant belongs to)
// and then sent to the add route; it is never returned by the server and is dropped from
// state after a successful add. "Edit" can send a new grant for the same account (after
// a reconnect in Nylas) the same way, and drops it from state after a successful save.

interface Mailbox {
  id: string;
  label: string;
  address: string;
  isDefault: boolean;
  pending_migration?: boolean;
  /** Why the migration has not happened yet, when Curia knows. */
  pending_migration_reason?: string;
}

interface RemovalPreview {
  mailbox: Mailbox;
  isDefault: boolean;
  isPrimaryEmail: boolean;
  stillOwnedDefault: boolean;
  otherLive: Mailbox[];
  primaryEmailCandidates: string[];
  /** null when the rules document could not be read. */
  scopedRules: Array<{ title: string; onlyThisMailbox: boolean }> | null;
  rulesUnreadable?: boolean;
  calendars: Array<{ calendarId: string; label: string }>;
  /** True when the calendar registry could not be read: calendars is then empty (unknown). */
  calendarsUnreadable?: boolean;
}

const BASE = '/api/registry/principal-mailboxes';
/** Why a mailbox id would be refused, or null when it is fine. Uses the server's own
 *  rule (imported, not copied, so a newly reserved id can't drift); the server still
 *  enforces it, this only explains a bad id before the add is tried. */
function idProblem(value: string): string | null {
  if (value === '') return 'Enter a mailbox id.';
  if (RESERVED_MAILBOX_IDS.has(value)) return `"${value}" is reserved. Choose another name.`;
  if (value.length > 32) return 'Use at most 32 characters.';
  if (!/^[a-z]/.test(value)) return 'Start with a lowercase letter.';
  if (!MAILBOX_ID_RE.test(value)) return 'Use only lowercase letters, numbers and hyphens.';
  return null;
}

// Refusals answer 422 { refusal, detail }; other failures { error }.
async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string; detail?: string };
      if (d.detail) return d.detail;
      if (d.error) return d.error;
    } catch (err) {
      console.error('[PrincipalMailboxesSection errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// A change that committed but left follow-up work: shown after the list reloads.
async function successNotice(res: Response): Promise<string | null> {
  try {
    const d = await res.json() as {
      warning?: string; cleanup_incomplete?: string[];
    };
    const parts: string[] = [];
    if (d.warning) parts.push(d.warning);
    if (d.cleanup_incomplete && d.cleanup_incomplete.length > 0) {
      parts.push(`Removed, but some cleanup did not finish (${d.cleanup_incomplete.join(', ')}); check the server logs.`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  } catch (err) {
    console.error('[PrincipalMailboxesSection successNotice] failed to parse the response body:', err);
    return null;
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function RemovePanel({ preview, onDone, onCancel }: {
  preview: RemovalPreview;
  onDone: (notice: string | null) => void;
  onCancel: () => void;
}) {
  const [stillOwned, setStillOwned] = useState(preview.stillOwnedDefault);
  const [newDefaultId, setNewDefaultId] = useState('');
  const [newPrimary, setNewPrimary] = useState('');
  const [rulesChoice, setRulesChoice] = useState<'' | 'delete' | 'move'>('');
  const [rescopeTo, setRescopeTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const scopedRules = preview.scopedRules ?? [];
  const needsRules = scopedRules.some(r => r.onlyThisMailbox);
  const rulesReady = !needsRules || rulesChoice === 'delete' || (rulesChoice === 'move' && rescopeTo !== '');
  const needsDefault = preview.isDefault && preview.otherLive.length > 0;
  const needsPrimary = preview.isPrimaryEmail;
  const noPrimaryChoice = needsPrimary && preview.primaryEmailCandidates.length === 0;
  const ready = !noPrimaryChoice && (!needsDefault || newDefaultId !== '') && (!needsPrimary || newPrimary !== '') && rulesReady;

  const confirm = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { still_owned: stillOwned };
      if (needsDefault) body['new_default_id'] = newDefaultId;
      if (needsPrimary) body['new_primary_email'] = newPrimary;
      if (needsRules) body['rules'] = rulesChoice === 'delete' ? 'delete' : { rescope_to: rescopeTo };
      const res = await apiFetch(`${BASE}/${encodeURIComponent(preview.mailbox.id)}`, jsonInit('DELETE', body));
      if (!res.ok) throw new Error(await errorMessage(res));
      onDone(await successNotice(res));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to remove mailbox');
    } finally {
      setBusy(false);
    }
  }, [stillOwned, needsDefault, needsPrimary, newDefaultId, newPrimary, needsRules, rulesChoice, rescopeTo, preview.mailbox.id, onDone]);

  return (
    <div className="form-field" style={{ border: '1px solid var(--border, #ccc)', padding: 8, borderRadius: 6 }}>
      <strong>Remove {preview.mailbox.label} ({preview.mailbox.address})</strong>

      <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
        <legend>Is this address still yours?</legend>
        <label>
          <input type="radio" name="still-owned" aria-label="Still mine: yes" checked={stillOwned}
            onChange={() => setStillOwned(true)} /> Yes, keep it as a known address of mine
        </label>
        <br />
        <label>
          <input type="radio" name="still-owned" aria-label="Still mine: no" checked={!stillOwned}
            onChange={() => setStillOwned(false)} /> No, forget it
        </label>
      </fieldset>

      {needsDefault && (
        <label style={{ display: 'block', marginBottom: 6 }}>
          This is the default mailbox. Make this the new default:{' '}
          <select aria-label="New default mailbox" value={newDefaultId} onChange={e => setNewDefaultId(e.target.value)}>
            <option value="">Choose…</option>
            {preview.otherLive.map(m => <option key={m.id} value={m.id}>{m.label} ({m.address})</option>)}
          </select>
        </label>
      )}

      {noPrimaryChoice && (
        <p className="autonomy-error" style={{ margin: '0 0 8px' }}>
          This is the principal's primary email. Add another email address for yourself (Contacts)
          before removing this one.
        </p>
      )}
      {needsPrimary && !noPrimaryChoice && (
        <label style={{ display: 'block', marginBottom: 6 }}>
          This is the principal's primary email. Use instead:{' '}
          <select aria-label="New primary email" value={newPrimary} onChange={e => setNewPrimary(e.target.value)}>
            <option value="">Choose…</option>
            {preview.primaryEmailCandidates.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      )}

      {preview.scopedRules === null && (
        <p className="autonomy-error" style={{ margin: '0 0 8px' }}>
          Couldn't check the inbox rules. You can still remove this mailbox; afterwards, check that no
          rule is left scoped to it.
        </p>
      )}
      {scopedRules.length > 0 && (
        <div>
          <span>Rules that mention this mailbox:</span>
          <ul>
            {scopedRules.map((r, i) => (
              <li key={i}>{r.title}{r.onlyThisMailbox ? ' (only this mailbox, will stop applying)' : ''}</li>
            ))}
          </ul>
          {needsRules && (
            <fieldset style={{ border: 0, padding: 0, margin: '4px 0 8px' }}>
              <legend>What should happen to the rules that apply only to this mailbox?</legend>
              <label>
                <input type="radio" name="rules-choice" aria-label="Rules: delete them" checked={rulesChoice === 'delete'}
                  onChange={() => setRulesChoice('delete')} /> Delete them
              </label>
              <br />
              <label>
                <input type="radio" name="rules-choice" aria-label="Rules: move them" checked={rulesChoice === 'move'}
                  disabled={preview.otherLive.length === 0} onChange={() => setRulesChoice('move')} /> Move them to another mailbox:{' '}
                <select aria-label="Move rules to" value={rescopeTo} disabled={rulesChoice !== 'move'}
                  onChange={e => setRescopeTo(e.target.value)}>
                  <option value="">Choose…</option>
                  {preview.otherLive.map(m => <option key={m.id} value={m.id}>{m.label} ({m.address})</option>)}
                </select>
              </label>
            </fieldset>
          )}
        </div>
      )}
      {preview.calendars.length > 0 && (
        <div>
          <span>Calendars read through this mailbox (disconnected by the removal):</span>
          <ul>{preview.calendars.map(c => <li key={c.calendarId}>{c.label}</li>)}</ul>
        </div>
      )}
      {preview.calendarsUnreadable && (
        <p style={{ margin: '0 0 8px' }}>Could not read which calendars go through this mailbox; they are disconnected by the removal too.</p>
      )}

      {err && <p className="autonomy-error" style={{ margin: '0 0 8px' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-danger btn-sm" disabled={busy || !ready} onClick={() => void confirm()}>
          Remove mailbox
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// The server's label limit (MAX_LABEL in routes/principal-mailboxes.ts).
const MAX_LABEL = 80;

type MailboxEdit = { id: string; label: string; grantId: string };

/** The inline Edit form for one mailbox row: its label and, optionally, a new grant. */
function EditMailboxForm({ mailbox, edit, locked, busy, onChange, onSave, onCancel }: {
  mailbox: Mailbox;
  edit: MailboxEdit;
  locked: boolean;
  busy: boolean;
  onChange: (edit: MailboxEdit) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const labelBlank = edit.label.trim() === '';
  const changed = edit.grantId.trim() !== '' || edit.label.trim() !== mailbox.label;
  const helpId = `mailbox-edit-grant-help-${mailbox.id}`;
  return (
    <div className="mailbox-edit-form">
      <label className="mailbox-edit-field">
        <span>Label</span>
        <input type="text" aria-label={`Label for ${mailbox.label}`} value={edit.label} maxLength={MAX_LABEL}
          onChange={e => onChange({ ...edit, label: e.target.value })} />
      </label>
      {labelBlank && <p className="autonomy-error mailbox-id-help" role="alert">Enter a label.</p>}
      <label className="mailbox-edit-field">
        <span>Nylas grant ID</span>
        <input type="password" autoComplete="off" placeholder="Paste a new grant ID"
          aria-label={`New grant ID for ${mailbox.label}`} aria-describedby={helpId} value={edit.grantId}
          onChange={e => onChange({ ...edit, grantId: e.target.value })} />
      </label>
      <p id={helpId} className="settings-page-sub mailbox-id-help">
        Leave blank to keep the current grant. Paste a new one after reconnecting this account in Nylas.
      </p>
      <span className="mailbox-row-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={locked || labelBlank || !changed}
          onClick={onSave}>Save</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </span>
    </div>
  );
}

export function PrincipalMailboxesSection({ readOnly = false }: { readOnly?: boolean } = {}) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<RemovalPreview | null>(null);
  // The row being edited: its label (pre-filled) and an optional replacement grant
  // (blank keeps the current one). One form for both, instead of Rename + Replace grant.
  const [editing, setEditing] = useState<{ id: string; label: string; grantId: string } | null>(null);

  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [grantId, setGrantId] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [tested, setTested] = useState<{ email: string; provider: string; grantId: string } | null>(null);
  // The grant input as typed now: a Test answer for an older value is dropped, never shown.
  const grantInput = useRef('');

  // Only the latest load writes state (same guard as EmailAccountsSection).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await apiFetch(BASE);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { mailboxes: Mailbox[] };
      if (seq !== loadSeq.current) return;
      setMailboxes(data.mailboxes ?? []);
      setErr(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setErr(e instanceof Error ? e.message : 'Failed to load mailboxes');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : fallback); } finally { setBusy(false); }
  }, []);

  const test = () => run(async () => {
    const asked = grantId.trim();
    const res = await apiFetch(`${BASE}/test`, jsonInit('POST', { grant_id: asked }));
    if (!res.ok) throw new Error(await errorMessage(res));
    const d = await res.json() as { email: string; provider: string };
    if (grantInput.current.trim() !== asked) return; // the grant changed while the test ran
    setTested({ ...d, grantId: asked });
  }, 'Test failed');

  const add = () => run(async () => {
    const res = await apiFetch(BASE, jsonInit('POST', {
      id: id.trim(), label: label.trim(), grant_id: grantId.trim(), make_default: makeDefault,
    }));
    if (!res.ok) throw new Error(await errorMessage(res));
    const added = await successNotice(res);
    setId(''); setLabel(''); setGrantId(''); grantInput.current = ''; setMakeDefault(false); setTested(null); // drop the grant from state
    await load();
    setNotice(added);
  }, 'Failed to add mailbox');

  // One PATCH; returns the success notice (a committed change with follow-up work), if any.
  const sendPatch = async (mid: string, body: Record<string, unknown>): Promise<string | null> => {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(mid)}`, jsonInit('PATCH', body));
    if (!res.ok) throw new Error(await errorMessage(res));
    return successNotice(res);
  };

  const makeDefaultMailbox = (mid: string) => run(async () => {
    const updated = await sendPatch(mid, { make_default: true });
    await load();
    setNotice(updated);
  }, 'Failed to update mailbox');

  // The server takes one change per PATCH (so a failure never leaves half a change behind
  // an error), so an edit of both fields is two requests. The grant goes first: it is the
  // one Nylas can refuse, and if it is refused nothing has changed. A label failure after
  // a saved grant says so, clears the grant (it's applied) and keeps the form for a retry.
  const saveEdit = (m: Mailbox, edit: { label: string; grantId: string }) => run(async () => {
    const newGrant = edit.grantId.trim();
    const newLabel = edit.label.trim();
    const notices: string[] = [];
    if (newGrant !== '') {
      const n = await sendPatch(m.id, { grant_id: newGrant });
      if (n) notices.push(n);
      // Applied: drop the grant from state now, whatever happens to the label.
      setEditing(cur => cur && cur.id === m.id ? { ...cur, grantId: '' } : cur);
    }
    if (newLabel !== m.label) {
      try {
        const n = await sendPatch(m.id, { label: newLabel });
        if (n) notices.push(n);
      } catch (e) {
        if (newGrant === '') throw e;
        await load(); // show the saved grant's effects before reporting the label failure
        const why = e instanceof Error ? e.message : 'unknown error';
        throw new Error(`The new grant was saved, but the label was not: ${why}`);
      }
    }
    setEditing(null);
    await load();
    setNotice(notices.length > 0 ? notices.join(' ') : null);
  }, 'Failed to update mailbox');

  const startRemove = (mid: string) => run(async () => {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(mid)}/removal-preview`);
    if (!res.ok) throw new Error(await errorMessage(res));
    setRemoving(await res.json() as RemovalPreview);
  }, 'Failed to load the removal preview');

  const idOk = idProblem(id.trim()) === null;
  // Only explain once something is typed: an empty field isn't an error yet.
  const idError = id.trim() === '' ? null : idProblem(id.trim());
  // Add sends the grant in the input, so the tested address must be that grant's.
  const testedCurrent = tested !== null && tested.grantId === grantId.trim();
  // The first thing still missing before Add can run, shown under the button so a
  // disabled Add always says why. The id's own problem is already shown under its field.
  const addBlocker =
    !idOk ? (idError ? null : 'Enter a mailbox id.')
    : !label.trim() ? 'Enter a label.'
    : !grantId.trim() ? 'Enter the Nylas grant ID.'
    // Editing the grant clears `tested`, so this also covers "changed since the last test".
    : !testedCurrent ? 'Test the grant ID first.'
    : null;
  // While the deferred-migration fallback is served, adding is refused until that mailbox has
  // moved into the list (an added row would hide it).
  const migrating = mailboxes.some(m => m.pending_migration);
  // Every control that changes a mailbox is off while busy or read-only.
  const locked = busy || readOnly;

  return (
    <div className="form-field">
      <label>Mailboxes</label>
      <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
        Each Gmail account of yours that Curia reads, with its calendars.
      </p>
      {err && <p className="autonomy-error" style={{ margin: '0 0 8px' }}>{err}</p>}
      {notice && <p className="settings-page-sub" role="status" style={{ margin: '0 0 8px' }}>{notice}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mailboxes.map(m => (
          // Own class, not status-pill: that one adds a status dot and capitalizes text (#2600).
          <div key={m.id} className="mailbox-row">
            <span>
              <strong>{m.label}</strong>
              {' — '}{m.address || 'address not read yet'}
              {m.isDefault && <span className="badge-default" style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Default</span>}
            </span>
            {m.pending_migration ? (
              <span className="settings-page-sub">
                Curia is still moving this mailbox into the list. Curia retries at each restart and
                once a day; {m.pending_migration_reason
                  ? <>it has not finished because: {m.pending_migration_reason}.</>
                  : "if it doesn't finish, check the Nylas API key and the grant."}
              </span>
            ) : editing?.id === m.id ? (
              <EditMailboxForm
                mailbox={m}
                edit={editing}
                locked={locked}
                busy={busy}
                onChange={setEditing}
                onSave={() => void saveEdit(m, editing)}
                onCancel={() => setEditing(null)}
              />
            ) : (
            <span className="mailbox-row-actions">
              <button type="button" className="btn btn-secondary btn-sm" disabled={locked}
                onClick={() => setEditing({ id: m.id, label: m.label, grantId: '' })}>Edit</button>
              {!m.isDefault && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={locked}
                  onClick={() => void makeDefaultMailbox(m.id)}>Make default</button>
              )}
              <button type="button" className="btn btn-danger btn-sm" disabled={locked}
                onClick={() => void startRemove(m.id)}>Remove</button>
            </span>
            )}
          </div>
        ))}
        {mailboxes.length === 0 && <span className="settings-page-sub">No mailboxes yet.</span>}
      </div>

      {removing && (
        <RemovePanel
          // Keyed by mailbox: a preview for another mailbox starts with fresh choices.
          key={removing.mailbox.id}
          preview={removing}
          onCancel={() => setRemoving(null)}
          onDone={(n) => { setRemoving(null); setNotice(n); void load(); }}
        />
      )}

      {/* Read-only (no API key yet): the page says why; nothing here can change. */}
      {!readOnly && (
        <p className="settings-page-sub" style={{ margin: '12px 0 0' }}>
          Changes apply at once, no restart needed. After reconnecting a mailbox's account in
          Nylas, use Edit to paste its new grant ID.
        </p>
      )}

      {!migrating && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <ConnectWithGoogle target="principal" disabled={readOnly} />
        <details>
        <summary>Paste a grant ID instead</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        <input type="text" placeholder="mailbox id (e.g. work)" value={id} aria-label="Mailbox id" disabled={readOnly}
          aria-describedby={idError ? 'mailbox-id-help mailbox-id-error' : 'mailbox-id-help'}
          aria-invalid={idError !== null}
          onChange={e => setId(e.target.value)} />
        {/* The id is ours, not Nylas's, and permanent: Edit changes only the label and grant,
            and a used id is never reused even after removal (id_taken in admin.ts). */}
        <p id="mailbox-id-help" className="settings-page-sub mailbox-id-help">
          A short name you choose, like <code>work</code>. Lowercase letters, numbers and
          hyphens. It can't be changed later.
        </p>
        {idError && (
          <p id="mailbox-id-error" className="autonomy-error mailbox-id-help" role="alert">{idError}</p>
        )}
        <input type="text" placeholder="label (e.g. Work)" value={label} aria-label="Label" disabled={readOnly}
          onChange={e => setLabel(e.target.value)} />
        <input type="password" autoComplete="off" placeholder="Nylas grant ID (from the Nylas dashboard)"
          value={grantId} aria-label="Grant ID" disabled={readOnly}
          onChange={e => { grantInput.current = e.target.value; setGrantId(e.target.value); setTested(null); }} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={locked || !grantId.trim()}
            onClick={() => void test()}>Test</button>
          {testedCurrent && <span>Grant belongs to <strong>{tested.email}</strong> ({tested.provider})</span>}
        </div>
        {mailboxes.length > 0 && (
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={makeDefault} disabled={readOnly} onChange={e => setMakeDefault(e.target.checked)} /> Make this the default
          </label>
        )}
        {/* alignSelf: the column container would otherwise stretch it to full width. */}
        <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}
          disabled={locked || !testedCurrent || !label.trim() || !idOk}
          aria-describedby={addBlocker ? 'mailbox-add-blocker' : undefined}
          onClick={() => void add()}>Add mailbox</button>
        {addBlocker && (
          <p id="mailbox-add-blocker" className="settings-page-sub mailbox-id-help">{addBlocker}</p>
        )}
        </div>
        </details>
      </div>
      )}
    </div>
  );
}
