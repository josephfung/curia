// The channel steps' inline forms (#2358, PR 3b): a channel's credentials, saved to the
// vault and the channel turned on, and the principal's id on a channel, linked to their
// contact. Built on the routes Settings → Channels and Contacts use.
import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';

/** GET /api/registry/channels → one entry (src/registry/channel-registry-types.ts). */
interface ChannelEntry {
  name: string;
  state: 'uninstalled' | 'installed' | 'enabled';
  credentialFields: Array<{ key: string; label: string; secret: boolean; configured: boolean }>;
  requiredResolvable: boolean;
}

export interface FieldSpec {
  /** The credential key, saved as channel.<channel>.<key>. */
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** A phone number: saved as E.164 (see normalizePhone). */
  phone?: boolean;
}

/**
 * A phone number as the channels compare and send it: E.164, "+14165550100". Spaces, dashes,
 * dots and brackets an operator types are dropped; anything else is refused, because Signal,
 * Telnyx and the principal match compare the stored string exactly.
 */
export function normalizePhone(raw: string): { value: string } | { error: string } {
  const value = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(value)
    ? { value }
    : { error: 'Enter the number with its country code, like +14165550100.' };
}

async function loadChannel(channel: string): Promise<ChannelEntry> {
  const res = await apiFetch('/api/registry/channels');
  if (!res.ok) throw new Error(await errorMessage(res));
  const { channels } = await res.json() as { channels: ChannelEntry[] };
  const entry = channels.find((c) => c.name === channel);
  if (!entry) throw new Error(`This server has no ${channel} channel.`);
  return entry;
}

async function post(path: string): Promise<void> {
  const res = await apiFetch(path, { method: 'POST' });
  if (!res.ok) throw new Error(await errorMessage(res));
}

/**
 * Installs and turns on a channel once its required credentials resolve (for email, also a
 * mailbox). Returns false when something is still missing. It starts at Apply & restart.
 */
export async function turnOnChannelIfReady(channel: string): Promise<boolean> {
  const entry = await loadChannel(channel);
  if (entry.state === 'enabled') return true;
  if (!entry.requiredResolvable) return false;
  if (entry.state === 'uninstalled') await post(`/api/registry/channels/${channel}/install`);
  await post(`/api/registry/channels/${channel}/enable`);
  return true;
}

/**
 * A channel's credentials as Setup asks for them: the listed fields only, in this order,
 * each saved to the vault when filled in. A field already saved shows as saved and is
 * left alone unless a new value is typed. Once every required credential resolves, the
 * channel is installed and turned on; it starts with Apply & restart.
 */
export function ChannelCredentialsForm(props: {
  channel: string;
  fields: readonly FieldSpec[];
  submitLabel?: string;
  /**
   * Shown when every field on this form is saved but the channel still can't turn on: what
   * else it needs, that this page doesn't ask for (email: a mailbox; voice: LiveKit's keys).
   */
  incompleteNote?: string;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const { channel, fields, onChanged } = props;
  const [entry, setEntry] = useState<ChannelEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async (): Promise<ChannelEntry | null> => {
    try {
      const next = await loadChannel(channel);
      setEntry(next);
      return next;
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not read the channel.' });
      return null;
    }
  }, [channel]);

  useEffect(() => { void reload(); }, [reload]);

  const saved = (key: string) => entry?.credentialFields.find((f) => f.key === key)?.configured === true;
  const secret = (key: string) => entry?.credentialFields.find((f) => f.key === key)?.secret ?? true;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    let savedAny = false;
    try {
      // Check every typed number first, so a bad one saves nothing.
      const typed: Array<{ f: FieldSpec; value: string }> = [];
      for (const f of fields) {
        const raw = (values[f.key] ?? '').trim();
        if (!raw) continue;
        if (!f.phone) { typed.push({ f, value: raw }); continue; }
        const phone = normalizePhone(raw);
        if ('error' in phone) throw new Error(`${f.label}: ${phone.error}`);
        typed.push({ f, value: phone.value });
      }
      // One field at a time, so a failure names the field and nothing after it is half-saved.
      for (const { f, value } of typed) {
        const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(`channel.${channel}.${f.key}`)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (!res.ok) throw new Error(`${f.label}: ${await errorMessage(res)}`);
        // Never keep a saved credential in component state.
        setValues((v) => ({ ...v, [f.key]: '' }));
        savedAny = true;
      }
      const before = await loadChannel(channel);
      const on = await turnOnChannelIfReady(channel);
      const after = await reload();
      // The step's own fields all saved but still off: something this page doesn't ask for is
      // missing, and the step says what (incompleteNote); otherwise one of its fields is.
      const ownFieldsSaved = fields.every((f) => after?.credentialFields.find((c) => c.key === f.key)?.configured === true);
      setMessage({
        kind: 'ok',
        text: before.state === 'enabled' ? 'Saved. Changes apply when you apply and restart.'
          : on ? 'Saved and turned on. It starts when you apply and restart.'
          : ownFieldsSaved && props.incompleteNote ? props.incompleteNote
          : 'Saved. Add the rest to turn it on.',
      });
      await onChanged();
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Could not save.';
      // A save that landed before a later step failed (turning the channel on) is still saved.
      setMessage({ kind: 'error', text: savedAny ? `Saved, but couldn’t turn it on: ${text}` : text });
      await reload();
      if (savedAny) await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const nothingTyped = fields.every((f) => !(values[f.key] ?? '').trim());
  return (
    <form className="setup-fields" onSubmit={(e) => void submit(e)} noValidate>
      {fields.map((f) => (
        <label key={f.key} className="setup-field">
          <span className="setup-field-label">
            {f.label}{' '}
            {saved(f.key) ? <span className="setup-hint setup-saved">Saved</span> : f.hint && <span className="setup-hint">{f.hint}</span>}
          </span>
          <input
            type={secret(f.key) ? 'password' : 'text'}
            autoComplete="off"
            value={values[f.key] ?? ''}
            placeholder={saved(f.key) ? 'Saved. Type a new value to replace it.' : f.placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      <div className="setup-actions">
        <button type="submit" className="btn btn-secondary" disabled={busy || nothingTyped}>
          {busy ? 'Saving…' : props.submitLabel ?? 'Save'}
        </button>
      </div>
      {message && (
        <p className={`setup-status ${message.kind === 'ok' ? 'ok' : 'attention'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </form>
  );
}

interface Identity {
  id: string;
  channel: string;
  channelIdentifier: string;
  status: string;
}

/**
 * The principal's id on one channel (Signal number, mobile, Slack member id), linked to
 * their contact as a principal-stated identity. Nothing is sent to it.
 */
export function PrincipalIdentityField(props: {
  contactId: string | null;
  channel: 'signal' | 'sms' | 'slack';
  label: string;
  placeholder?: string;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const { contactId, channel, onChanged } = props;
  const [linked, setLinked] = useState<Identity[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!contactId) return;
    try {
      const res = await apiFetch(`/api/contacts/${encodeURIComponent(contactId)}/identities`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { identities: Identity[] };
      setLinked(data.identities.filter((i) => i.channel === channel && i.status === 'active'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the contact.');
    }
  }, [contactId, channel]);

  useEffect(() => { void reload(); }, [reload]);

  async function link(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!contactId || !value.trim()) return;
    setError(null);
    let identifier = value.trim();
    if (channel !== 'slack') {
      const phone = normalizePhone(identifier);
      if ('error' in phone) { setError(phone.error); return; }
      identifier = phone.value;
    }
    if (linked.some((i) => i.channelIdentifier === identifier)) {
      setValue('');
      setError('Already saved.');
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/contacts/${encodeURIComponent(contactId)}/identities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, channelIdentifier: identifier }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue('');
      await reload();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (!contactId) {
    return <p className="setup-hint">Save Who it’s for first: this links to the principal’s contact.</p>;
  }
  return (
    <form className="setup-fields setup-identity" onSubmit={(e) => void link(e)} noValidate>
      <label className="setup-field">
        <span className="setup-field-label">
          {props.label}{' '}
          {linked.length > 0 && <span className="setup-hint setup-saved">Saved: {linked.map((i) => i.channelIdentifier).join(', ')}</span>}
        </span>
        <span className="setup-inline">
          <input type="text" autoComplete="off" value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn btn-secondary" disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : linked.length > 0 ? 'Add another' : 'Save'}
          </button>
        </span>
      </label>
      {error && <p className="setup-status attention" role="alert">{error}</p>}
    </form>
  );
}
