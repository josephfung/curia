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
  /** Shown after a save that left the channel off (e.g. email still needs a mailbox). */
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
    try {
      // One field at a time, so a failure names the field and nothing after it is half-saved.
      for (const f of fields) {
        const value = (values[f.key] ?? '').trim();
        if (!value) continue;
        const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(`channel.${channel}.${f.key}`)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (!res.ok) throw new Error(`${f.label}: ${await errorMessage(res)}`);
        // Never keep a saved credential in component state.
        setValues((v) => ({ ...v, [f.key]: '' }));
      }
      const wasOn = (await reload())?.state === 'enabled';
      const on = await turnOnChannelIfReady(channel);
      await reload();
      setMessage({
        kind: 'ok',
        text: wasOn ? 'Saved. Changes apply when you apply and restart.'
          : on ? 'Saved and turned on. It starts when you apply and restart.'
          : props.incompleteNote ?? 'Saved. Add the rest to turn it on.',
      });
      await onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save.' });
      await reload();
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
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/contacts/${encodeURIComponent(contactId)}/identities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, channelIdentifier: value.trim() }),
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
