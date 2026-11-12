import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../api.js';

// ── Principal mailboxes section ──────────────────────────────────────────────
//
// Rendered inside the email channel's detail drawer in ChannelSettings.tsx (#2475).
// The principal's OWN Gmail mailboxes, separate from Curia's email accounts above it.
// A grant ID is typed once, tested (shows the address and provider the grant belongs to)
// and then sent to the add route; it is never returned by the server and is dropped from
// state after a successful add. "Replace grant" sends a new grant for the same account (after
// a reconnect in Nylas) the same way, and drops it from state after a successful save.

interface Mailbox {
  id: string;
  label: string;
  address: string;
  isDefault: boolean;
  pending_migration?: boolean;
}

interface RemovalPreview {
  mailbox: Mailbox;
  isDefault: boolean;
  isPrimaryEmail: boolean;
  stillOwnedDefault: boolean;
  otherLive: Mailbox[];
  primaryEmailCandidates: string[];
  scopedRules: Array<{ title: string; onlyThisMailbox: boolean }>;
  calendars: Array<{ calendarId: string; label: string }>;
}

const BASE = '/api/registry/principal-mailboxes';
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

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
      warning?: string; cleanup_incomplete?: string[]; restart_required?: boolean;
    };
    const parts: string[] = [];
    if (d.warning) parts.push(d.warning);
    if (d.cleanup_incomplete && d.cleanup_incomplete.length > 0) {
      parts.push(`Removed, but some cleanup did not finish (${d.cleanup_incomplete.join(', ')}); check the server logs.`);
    }
    if (d.restart_required) parts.push("Restart Curia so calendar stops using the removed mailbox's account.");
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsDefault = preview.isDefault && preview.otherLive.length > 0;
  const needsPrimary = preview.isPrimaryEmail;
  const noPrimaryChoice = needsPrimary && preview.primaryEmailCandidates.length === 0;
  const ready = !noPrimaryChoice && (!needsDefault || newDefaultId !== '') && (!needsPrimary || newPrimary !== '');

  const confirm = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { still_owned: stillOwned };
      if (needsDefault) body['new_default_id'] = newDefaultId;
      if (needsPrimary) body['new_primary_email'] = newPrimary;
      const res = await apiFetch(`${BASE}/${encodeURIComponent(preview.mailbox.id)}`, jsonInit('DELETE', body));
      if (!res.ok) throw new Error(await errorMessage(res));
      onDone(await successNotice(res));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to remove mailbox');
    } finally {
      setBusy(false);
    }
  }, [stillOwned, needsDefault, needsPrimary, newDefaultId, newPrimary, preview.mailbox.id, onDone]);

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

      {preview.scopedRules.length > 0 && (
        <div>
          <span>Rules that mention this mailbox:</span>
          <ul>
            {preview.scopedRules.map((r, i) => (
              <li key={i}>{r.title}{r.onlyThisMailbox ? ' (only this mailbox, will stop applying)' : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.calendars.length > 0 && (
        <div>
          <span>Calendars read through this mailbox:</span>
          <ul>{preview.calendars.map(c => <li key={c.calendarId}>{c.label}</li>)}</ul>
        </div>
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

export function PrincipalMailboxesSection() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<RemovalPreview | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [replacing, setReplacing] = useState<{ id: string; grantId: string } | null>(null);

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

  const patch = (mid: string, body: Record<string, unknown>) => run(async () => {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(mid)}`, jsonInit('PATCH', body));
    if (!res.ok) throw new Error(await errorMessage(res));
    const updated = await successNotice(res);
    setRenaming(null);
    setReplacing(null); // drop any replacement grant from state
    await load();
    setNotice(updated);
  }, 'Failed to update mailbox');

  const startRemove = (mid: string) => run(async () => {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(mid)}/removal-preview`);
    if (!res.ok) throw new Error(await errorMessage(res));
    setRemoving(await res.json() as RemovalPreview);
  }, 'Failed to load the removal preview');

  const idOk = ID_RE.test(id.trim()) && id.trim() !== 'primary' && id.trim() !== 'default';
  // Add sends the grant in the input, so the tested address must be that grant's.
  const testedCurrent = tested !== null && tested.grantId === grantId.trim();
  // The deferred-migration fallback counts as the one mailbox: adding is refused until it
  // has moved into the list.
  const migrating = mailboxes.some(m => m.pending_migration);

  return (
    <div className="form-field">
      <label>Principal's mailboxes</label>
      <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
        The principal's own Gmail mailboxes, which calendar and the inbox tools work in. They are
        not Curia's email accounts above.
      </p>
      {err && <p className="autonomy-error" style={{ margin: '0 0 8px' }}>{err}</p>}
      {notice && <p className="settings-page-sub" role="status" style={{ margin: '0 0 8px' }}>{notice}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mailboxes.map(m => (
          <div key={m.id} className="status-pill"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>
              {renaming?.id === m.id ? (
                <input type="text" aria-label="New label" value={renaming.label}
                  onChange={e => setRenaming({ id: m.id, label: e.target.value })} />
              ) : (
                <strong>{m.label}</strong>
              )}
              {' — '}{m.address || 'address not read yet'}
              {m.isDefault && <span className="badge-default" style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>Default</span>}
            </span>
            {m.pending_migration ? (
              <span className="settings-page-sub">
                Curia is still moving this mailbox into the list. Curia retries at each restart and
                once a day; if it doesn't finish, check the Nylas API key and the grant.
              </span>
            ) : (
            <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {replacing?.id === m.id ? (
                <>
                  <input type="password" autoComplete="off" placeholder="New Nylas grant ID"
                    aria-label={`New grant ID for ${m.label}`} value={replacing.grantId}
                    onChange={e => setReplacing({ id: m.id, grantId: e.target.value })} />
                  <button type="button" className="btn btn-secondary btn-sm"
                    disabled={busy || replacing.grantId.trim() === ''}
                    onClick={() => void patch(m.id, { grant_id: replacing.grantId.trim() })}>Save grant</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => setReplacing(null)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => setReplacing({ id: m.id, grantId: '' })}>Replace grant</button>
              )}
              {renaming?.id === m.id ? (
                <button type="button" className="btn btn-secondary btn-sm"
                  disabled={busy || renaming.label.trim() === ''}
                  onClick={() => void patch(m.id, { label: renaming.label.trim() })}>Save label</button>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => setRenaming({ id: m.id, label: m.label })}>Rename</button>
              )}
              {!m.isDefault && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                  onClick={() => void patch(m.id, { make_default: true })}>Make default</button>
              )}
              <button type="button" className="btn btn-danger btn-sm" disabled={busy}
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

      <p className="settings-page-sub" style={{ margin: '12px 0 0' }}>
        Calendar changes take effect after a restart, as does a replaced grant for calendar and
        for checking whom the principal has written to. Use Replace grant after reconnecting a
        mailbox's account in Nylas.
      </p>

      {!migrating && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <input type="text" placeholder="mailbox id (e.g. work)" value={id} aria-label="Mailbox id"
          onChange={e => setId(e.target.value)} />
        <input type="text" placeholder="label (e.g. Work)" value={label} aria-label="Label"
          onChange={e => setLabel(e.target.value)} />
        <input type="password" autoComplete="off" placeholder="Nylas grant ID (from the Nylas dashboard)"
          value={grantId} aria-label="Grant ID"
          onChange={e => { grantInput.current = e.target.value; setGrantId(e.target.value); setTested(null); }} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !grantId.trim()}
            onClick={() => void test()}>Test</button>
          {testedCurrent && <span>Grant belongs to <strong>{tested.email}</strong> ({tested.provider})</span>}
        </div>
        {mailboxes.length > 0 && (
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} /> Make this the default
          </label>
        )}
        <button type="button" className="btn btn-primary btn-sm"
          disabled={busy || !testedCurrent || !label.trim() || !id.trim() || (!idOk)}
          onClick={() => void add()}>Add mailbox</button>
      </div>
      )}
    </div>
  );
}
