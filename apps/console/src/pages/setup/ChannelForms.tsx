// The channel steps' inline forms (#2358, PR 3b): a channel's credentials, saved to the
// vault and the channel turned on, and the principal's id on a channel, linked to their
// contact. Built on the routes Settings → Channels and Contacts use.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type JSX, type Ref } from 'react';
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

/** What a step's field group gives the step: save anything still typed. */
export interface FieldGroupHandle {
  /** Saves what is typed and not yet saved. False when anything failed (its error shows). */
  flush: () => Promise<boolean>;
}

/**
 * A channel's credentials as Setup asks for them: the listed fields only, in this order.
 * There is no Save button (#2358, owner review): a field saves when the operator leaves it,
 * and the step's Save and continue saves whatever is still typed (flush). A field already
 * saved shows as saved and is left alone unless a new value is typed. Once every required
 * credential resolves, the channel is installed and turned on; it starts at Apply & restart.
 */
export function ChannelCredentialsForm(props: {
  channel: string;
  fields: readonly FieldSpec[];
  /**
   * Shown when every field on this form is saved but the channel still can't turn on: what
   * else it needs, that this page doesn't ask for (email: a mailbox; voice: LiveKit's keys).
   */
  incompleteNote?: string;
  onChanged: () => Promise<void>;
  ref?: Ref<FieldGroupHandle>;
}): JSX.Element {
  const { channel, fields, onChanged } = props;
  const [entry, setEntry] = useState<ChannelEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // The latest typed values, for a save that runs after the render that typed them.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // One save at a time: a blur and Save and continue can both ask.
  const running = useRef<Promise<boolean> | null>(null);

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

  async function saveTyped(): Promise<boolean> {
    // Check every typed number first, so a bad one saves nothing.
    // `submitted` is the text as typed: the field is cleared after its save only if it still
    // holds exactly that, so an edit made while the save ran is kept for the next save.
    const typed: Array<{ f: FieldSpec; value: string; submitted: string }> = [];
    for (const f of fields) {
      const submitted = valuesRef.current[f.key] ?? '';
      const raw = submitted.trim();
      if (!raw) continue;
      if (!f.phone) { typed.push({ f, value: raw, submitted }); continue; }
      const phone = normalizePhone(raw);
      if ('error' in phone) {
        setMessage({ kind: 'error', text: `${f.label}: ${phone.error}` });
        return false;
      }
      typed.push({ f, value: phone.value, submitted });
    }
    if (typed.length === 0) return retryTurnOn();
    let savedAny = false;
    try {
      // One field at a time, so a failure names the field and nothing after it is half-saved.
      for (const { f, value, submitted } of typed) {
        const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(`channel.${channel}.${f.key}`)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (!res.ok) throw new Error(`${f.label}: ${await errorMessage(res)}`);
        // Never keep a saved credential in component state, unless it was retyped while the
        // save ran: that newer value is kept for the next save.
        if (valuesRef.current[f.key] === submitted) {
          valuesRef.current = { ...valuesRef.current, [f.key]: '' };
          setValues((v) => (v[f.key] === submitted ? { ...v, [f.key]: '' } : v));
        }
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
      return true;
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Could not save.';
      // A save that landed before a later step failed (turning the channel on) is still saved.
      setMessage({ kind: 'error', text: savedAny ? `Saved, but couldn’t turn it on: ${text}` : text });
      await reload();
      if (savedAny) await onChanged();
      return false;
    }
  }

  /**
   * Nothing typed: the step may move on, unless the channel's credentials resolve but it is
   * still off (an earlier turn-on failed). Then turning it on is retried, and a failure keeps
   * the step open. A channel whose credentials were never entered stays skippable.
   */
  async function retryTurnOn(): Promise<boolean> {
    try {
      const current = await loadChannel(channel);
      if (current.state === 'enabled' || !current.requiredResolvable) return true;
      await turnOnChannelIfReady(channel);
      await reload();
      setMessage({ kind: 'ok', text: 'Turned on. It starts when you apply and restart.' });
      await onChanged();
      return true;
    } catch (err) {
      setMessage({ kind: 'error', text: `Couldn’t turn it on: ${err instanceof Error ? err.message : 'unknown error'}` });
      return false;
    }
  }

  // Waits for a save already running, then saves what is still typed.
  async function flush(): Promise<boolean> {
    while (running.current) await running.current;
    running.current = saveTyped();
    try {
      return await running.current;
    } finally {
      running.current = null;
    }
  }

  useImperativeHandle(props.ref, () => ({ flush }));

  return (
    <div className="setup-fields">
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
            onChange={(e) => {
              const value = e.target.value;
              valuesRef.current = { ...valuesRef.current, [f.key]: value };
              setValues((v) => ({ ...v, [f.key]: value }));
            }}
            // Leaving any field saves everything typed in the group.
            onBlur={() => { if (Object.values(valuesRef.current).some((v) => v.trim())) void flush(); }}
          />
        </label>
      ))}
      {message && (
        <p className={`setup-status ${message.kind === 'ok' ? 'ok' : 'attention'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
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
 * their contact as a principal-stated identity. Nothing is sent to it. Like the credentials,
 * it saves when the operator leaves the field, and on the step's Save and continue.
 */
export function PrincipalIdentityField(props: {
  contactId: string | null;
  channel: 'signal' | 'sms' | 'slack';
  label: string;
  placeholder?: string;
  onChanged: () => Promise<void>;
  ref?: Ref<FieldGroupHandle>;
}): JSX.Element {
  const { contactId, channel, onChanged } = props;
  const [linked, setLinked] = useState<Identity[]>([]);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const running = useRef<Promise<boolean> | null>(null);

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

  async function link(): Promise<boolean> {
    // As typed: cleared afterwards only if the field still holds exactly this (an edit made
    // while the request ran is kept for the next save).
    const submitted = valueRef.current;
    const typed = submitted.trim();
    if (!typed) return true;
    if (!contactId) return false;
    setError(null);
    let identifier = typed;
    if (channel !== 'slack') {
      const phone = normalizePhone(identifier);
      if ('error' in phone) { setError(phone.error); return false; }
      identifier = phone.value;
    }
    if (linked.some((i) => i.channelIdentifier === identifier)) {
      clearIfUnchanged(submitted);
      return true;
    }
    try {
      const res = await apiFetch(`/api/contacts/${encodeURIComponent(contactId)}/identities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, channelIdentifier: identifier }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      clearIfUnchanged(submitted);
      await reload();
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      return false;
    }
  }

  function clearIfUnchanged(submitted: string): void {
    if (valueRef.current !== submitted) return;
    valueRef.current = '';
    setValue('');
  }

  async function flush(): Promise<boolean> {
    while (running.current) await running.current;
    running.current = link();
    try {
      return await running.current;
    } finally {
      running.current = null;
    }
  }

  useImperativeHandle(props.ref, () => ({ flush }));

  if (!contactId) {
    return <p className="setup-hint">Save Who it’s for first: this links to the principal’s contact.</p>;
  }
  return (
    <div className="setup-fields setup-identity">
      <label className="setup-field">
        <span className="setup-field-label">
          {props.label}{' '}
          {linked.length > 0 && <span className="setup-hint setup-saved">Saved: {linked.map((i) => i.channelIdentifier).join(', ')}</span>}
        </span>
        <input
          type="text"
          autoComplete="off"
          value={value}
          placeholder={linked.length > 0 ? 'Type another to add it' : props.placeholder}
          onChange={(e) => { valueRef.current = e.target.value; setValue(e.target.value); }}
          onBlur={() => { if (valueRef.current.trim()) void flush(); }}
        />
      </label>
      {error && <p className="setup-status attention" role="alert">{error}</p>}
    </div>
  );
}
