// The channel steps (#2358): Email, Messaging, Voice, and the Business Apps steps, Email &
// calendar and Google Workspace (#2683). Each takes its credentials inline (ChannelForms.tsx)
// and shows its live check from the Setup checklist.
// Messaging and Voice also save the route the operator picks, which their checks read.
import { useEffect, useRef, useState, type JSX } from 'react';
import { ConnectWithGoogle } from '../../components/ConnectWithGoogle.js';
import { EmailAccountsSection } from '../../components/EmailAccountsSection.js';
import { NylasSignInSetupSection } from '../../components/NylasSignInSetupSection.js';
import { GoogleWorkspaceSignIn } from '../../components/GoogleWorkspaceSignIn.js';
import { saveSetupFields, type MessagingRoute, type SetupFields, type VoiceRoute } from './setup-api.js';
import { atSentenceStart, sharedLatestSaver, type ChecklistTask } from './setup-steps.js';
import { ChoiceGroup, StatusLine, StepFooter } from './setup-ui.js';
import {
  ChannelCredentialsForm,
  PrincipalIdentityField,
  turnOnChannelIfReady,
  VaultKeysForm,
  type FieldGroupHandle,
  type FieldSpec,
  type VaultFieldSpec,
} from './ChannelForms.js';

export const DOCS_ORIGIN = 'https://docs.meetcuria.com';

interface StepProps {
  task: ChecklistTask | undefined;
  principal: string;
  onSaved: () => Promise<void>;
  onContinue: () => void;
  onHelp?: () => void;
}

/**
 * The step's one button (#2358, owner review): Save and continue saves anything still typed in
 * every field group on the step (each group also has its own Save button, #2683), and moves
 * on only when all of them saved. A failure stays on the step, with the error under its field.
 */
export function useSaveAndContinue(onContinue: () => void) {
  const groups = useRef(new Map<string, FieldGroupHandle>());
  const [saving, setSaving] = useState(false);
  const register = (name: string) => (handle: FieldGroupHandle | null) => {
    if (handle) groups.current.set(name, handle);
    else groups.current.delete(name);
  };
  async function saveAndContinue(): Promise<void> {
    setSaving(true);
    try {
      for (const group of groups.current.values()) {
        if (!(await group.flush())) return;
      }
      onContinue();
    } finally {
      setSaving(false);
    }
  }
  return { register, saveAndContinue, saving };
}

export function SaveAndContinue(props: { save: ReturnType<typeof useSaveAndContinue>; onHelp?: () => void }): JSX.Element {
  return (
    <StepFooter
      primary={props.save.saving ? 'Saving…' : 'Save and continue'}
      primaryDisabled={props.save.saving}
      onPrimary={() => void props.save.saveAndContinue()}
      onHelp={props.onHelp}
    />
  );
}

/** The step's live check and its guide. */
function TaskStatus({ task }: { task: ChecklistTask | undefined }): JSX.Element {
  return (
    <>
      {task?.status === 'done' && <StatusLine kind="ok">Done.</StatusLine>}
      {task && task.status !== 'done' && (
        <StatusLine kind={task.restart_required ? 'attention' : 'neutral'}>
          {task.restart_required ? 'Saved. Turns on when you apply and restart at the end.' : task.detail ?? 'Not set up yet.'}
        </StatusLine>
      )}
      {task?.docs_url && (
        <div className="setup-actions">
          <a className="setup-link" href={`${DOCS_ORIGIN}${task.docs_url}`} target="_blank" rel="noopener noreferrer">Setup guide</a>
        </div>
      )}
    </>
  );
}

// The one key both email steps use. Asked for on each page, so neither step sends the
// operator somewhere Setup doesn't let them go (Settings is behind Setup).
const NYLAS_KEY_FIELD: readonly FieldSpec[] = [{ key: 'nylas_api_key', label: 'Nylas API key', hint: 'from dashboard-v3.nylas.com' }];

export function EmailStep({ task, onSaved, onContinue, onHelp }: StepProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const save = useSaveAndContinue(onContinue);

  // Connect with Google adds Curia's mailbox on the server, then restarts Curia, without
  // turning the channel on. So on arrival turn it on if the key and a mailbox are both
  // there; the step's check then reads restart_required, not "add the key".
  const taskDone = task?.status === 'done';
  useEffect(() => {
    if (taskDone) return;
    let cancelled = false;
    void (async () => {
      try {
        if (await turnOnChannelIfReady('email') && !cancelled) await onSaved();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not turn on email.');
      }
    })();
    return () => { cancelled = true; };
    // Once per arrival; mailboxChanged covers changes made on this step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A mailbox added or connected: the channel turns on once it has both the key and a mailbox.
  async function mailboxChanged(): Promise<void> {
    setError(null);
    try {
      await turnOnChannelIfReady('email');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn on email.');
    }
    await onSaved();
  }

  return (
    <div>
      <h2>Curia’s own email</h2>
      <p className="setup-lede">A dedicated mailbox Curia sends and receives from. Add your Nylas API key, then connect Curia’s mailbox.</p>
      <ChannelCredentialsForm
        channel="email"
        fields={NYLAS_KEY_FIELD}
        ref={save.register('key')}
        incompleteNote="Saved. Now connect Curia’s mailbox below."
        onChanged={onSaved}
      />
      <div className="setup-section">
        <span className="setup-section-label">Curia’s mailbox</span>
        <span className="setup-hint">Connect a Google account for Curia to send from. It starts when you apply and restart.</span>
      </div>
      <EmailAccountsSection showHeading={false} onChanged={() => void mailboxChanged()} />
      {error && <p className="setup-status attention" role="alert">{error}</p>}
      <TaskStatus task={task} />
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}

export function SignInStep({ task, principal, onSaved, onContinue, onHelp }: StepProps): JSX.Element {
  const save = useSaveAndContinue(onContinue);
  // The Nylas panel reads the key itself; remount it after a save so it checks again.
  const [keyVersion, setKeyVersion] = useState(0);
  return (
    <div>
      <h2>{atSentenceStart(principal)}’s email and calendar</h2>
      <p className="setup-lede">
        Lets {principal} connect their own Google account by signing in, with no grant IDs to copy. It uses the same Nylas key as
        the Email step. A connected mailbox isn’t needed to finish Setup: {principal} can connect it in the first conversation.
      </p>
      <ChannelCredentialsForm
        channel="email"
        fields={NYLAS_KEY_FIELD}
        ref={save.register('key')}
        incompleteNote="Saved. Curia’s own mailbox is connected in the Email step."
        onChanged={async () => { setKeyVersion((v) => v + 1); await onSaved(); }}
      />
      <div className="setup-panel">
        <NylasSignInSetupSection key={keyVersion} keyLocation="in the field above" />
      </div>
      <div className="setup-actions">
        <ConnectWithGoogle target="principal" hideUnlessReady />
      </div>
      <TaskStatus task={task} />
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}

const GOOGLE_FIELDS: readonly VaultFieldSpec[] = [
  { key: 'curia_google_email', label: 'Curia’s Google address', placeholder: 'curia@example.com', plain: true, email: true },
  { key: 'google_oauth_client_id', label: 'OAuth client ID', hint: 'from Google Cloud', plain: true },
  { key: 'google_oauth_client_secret', label: 'OAuth client secret' },
];

/**
 * Curia's own Google account for Docs, Sheets and Drive (#2683). Required: the deep dive in the
 * principal's first conversation delivers its drafts as Google Docs. Done means signed in and
 * Google still accepting the token, so the step's own sign-in line is its status.
 */
export function GoogleWorkspaceStep({ task, principal, onSaved, onContinue, onHelp }: StepProps): JSX.Element {
  const save = useSaveAndContinue(onContinue);
  // Bumped when a field saves, so the sign-in panel checks again.
  const [fieldsVersion, setFieldsVersion] = useState(0);
  // Every field filled in, typed or saved: Sign in as Curia saves what is typed, then starts.
  const [filled, setFilled] = useState(false);
  const fieldsRef = useRef<FieldGroupHandle | null>(null);
  const registerFields = save.register('google');
  const done = task?.status === 'done';
  return (
    <div>
      <h2>Google Workspace</h2>
      <p className="setup-lede">
        Lets Curia work in Google Docs, Sheets and Drive from its own Google account, and share files with {principal}.
        In the first conversation Curia delivers its drafts to {principal} as Google Docs, so this step is needed to finish Setup.
      </p>
      <VaultKeysForm
        ref={(handle) => { registerFields(handle); fieldsRef.current = handle; }}
        fields={GOOGLE_FIELDS}
        onChanged={async () => { setFieldsVersion((v) => v + 1); await onSaved(); }}
        onFilledChange={setFilled}
      />
      <div className="setup-note">
        You can reuse the Google Cloud project and Web application OAuth client from {principal}’s email &amp; calendar.
        Enable the Drive, Docs and Sheets APIs there. Google shows a client secret only once, so on that client
        choose <b>Add secret</b> and paste the new one here; keep the old secret, which Nylas still uses.
      </div>
      <GoogleWorkspaceSignIn
        refreshKey={fieldsVersion}
        fieldsFilled={filled}
        beforeSignIn={() => fieldsRef.current?.flush() ?? Promise.resolve(true)}
        // The checklist caches nothing the panel doesn't: when they disagree, re-read it.
        onStatus={(state) => { if ((state === 'signed_in') !== done) void onSaved(); }}
      />
      {task?.docs_url && (
        <div className="setup-actions">
          <a className="setup-link" href={`${DOCS_ORIGIN}${task.docs_url}`} target="_blank" rel="noopener noreferrer">Guide: Google Cloud setup</a>
        </div>
      )}
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}

interface RouteStepProps extends StepProps {
  fields: SetupFields;
  /** The principal's contact, for their id on Signal, SMS or Slack. */
  contactId: string | null;
}

const MESSAGING_CHOICES: Array<{ id: MessagingRoute; title: string; desc: (p: string) => string; tag?: string }> = [
  { id: 'app', title: 'Curia app', desc: (p) => `Installs on ${p}’s phone from a link. No phone number needed.`, tag: 'Recommended' },
  { id: 'signal', title: 'Signal', desc: () => 'For someone who already uses Signal. Needs a number for Curia.' },
  { id: 'sms', title: 'Text message (SMS)', desc: () => 'Works on any phone. Needs a Telnyx number.' },
  { id: 'slack', title: 'Slack', desc: () => 'For someone who lives in Slack. Needs Curia’s Slack app in their workspace.' },
];

// Each route's credentials, in the words of the Setup page (the catalog's labels are the
// Settings page's). Keys are src/channels/catalog.ts's.
const ROUTE_FIELDS: Record<Exclude<MessagingRoute, 'app'>, readonly FieldSpec[]> = {
  signal: [
    { key: 'phone_number', label: 'Curia’s Signal number', placeholder: '+14165550142', phone: true },
    { key: 'socket_path', label: 'Signal server socket', hint: 'where signal-cli listens', placeholder: '/var/run/signal-cli/socket' },
  ],
  sms: [
    { key: 'api_key', label: 'Telnyx API key' },
    { key: 'from_number', label: 'Curia’s number', placeholder: '+14165550188', phone: true },
    { key: 'webhook_public_key', label: 'Telnyx webhook public key' },
  ],
  slack: [
    { key: 'bot_token', label: 'Slack bot token', placeholder: 'xoxb-…' },
    { key: 'app_token', label: 'Slack app-level token', placeholder: 'xapp-…' },
  ],
};

const IDENTITY_LABEL: Record<Exclude<MessagingRoute, 'app'>, { noun: string; placeholder: string }> = {
  signal: { noun: 'Signal number', placeholder: '+14165550100' },
  sms: { noun: 'mobile number', placeholder: '+14165550100' },
  slack: { noun: 'Slack member ID', placeholder: 'U0123ABCD' },
};

/**
 * The route saved one pick at a time, newest last (createLatestSaver). While a pick is
 * unsaved the screen shows it; otherwise it follows what is stored, so a failed save shows
 * the stored route again. The step stays mounted across refreshes, so keyboard focus holds.
 * The save queue outlives the step (`sharedLatestSaver` under `key`), so picks made either
 * side of a visit to another step still save in order.
 */
function useRoute<T extends string>(key: string, storedRoute: T | null, save: (next: T) => Promise<void>, onSaved: () => Promise<void>) {
  const [route, setRoute] = useState<T | null>(storedRoute);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(0);
  const stored = useRef(storedRoute);
  stored.current = storedRoute;
  // The latest save, not the first render's: Messaging's reads the current voice route.
  const latestSave = useRef(save);
  latestSave.current = save;
  const saver = sharedLatestSaver(key, (next: T) => latestSave.current(next));
  useEffect(() => {
    if (pending.current === 0) setRoute(storedRoute);
  }, [storedRoute]);

  async function pick(next: T): Promise<void> {
    setRoute(next);
    setError(null);
    pending.current++;
    let failed = false;
    try {
      await saver(next);
    } catch (err) {
      failed = true;
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      pending.current--;
    }
    if (pending.current > 0) return;
    // Re-read the checklist and the stored route. After a failure the screen shows what is
    // stored, even when that didn't change (so the effect above wouldn't fire).
    await onSaved();
    if (failed) setRoute(stored.current);
  }
  return { route, error, pick };
}

export function MessagingStep({ task, principal, fields, contactId, onSaved, onContinue, onHelp }: RouteStepProps): JSX.Element {
  const { route, error, pick } = useRoute<MessagingRoute>('messaging-route', fields.messagingRoute, async (next) => {
    // Voice follows messaging until the operator picks it: Signal for Signal, else the app.
    await saveSetupFields({
      messagingRoute: next,
      ...(fields.voiceRoute === null ? { voiceRoute: next === 'signal' ? 'signal' : 'app' } : {}),
    });
  }, onSaved);
  const save = useSaveAndContinue(onContinue);

  return (
    <div>
      <h2>How should Curia message {principal}?</h2>
      <p className="setup-lede">Pick the one {principal} will use day to day. You can add more later.</p>
      <ChoiceGroup
        label="Messaging route"
        value={route}
        onChange={(next) => void pick(next)}
        options={MESSAGING_CHOICES.map((c) => ({ value: c.id, title: c.title, description: c.desc(principal), tag: c.tag }))}
      />
      {error && <p className="setup-status attention" role="alert">{error}</p>}
      {route === 'app' && (
        <div className="setup-note">Nothing else to set up here. {atSentenceStart(principal)} installs the app from the link you’ll send when you start onboarding.</div>
      )}
      {route && route !== 'app' && (
        <>
          <ChannelCredentialsForm key={route} ref={save.register('credentials')} channel={route} fields={ROUTE_FIELDS[route]} onChanged={onSaved} />
          <PrincipalIdentityField
            key={`id-${route}`}
            ref={save.register('principal-id')}
            contactId={contactId}
            channel={route}
            label={`${atSentenceStart(principal)}’s ${IDENTITY_LABEL[route].noun}`}
            placeholder={IDENTITY_LABEL[route].placeholder}
            onChanged={onSaved}
          />
          <p className="setup-hint">Nothing is sent to {principal}.</p>
        </>
      )}
      {route && <TaskStatus task={task} />}
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}

// LiveKit's keys come with Curia (seeded at install, #2689), so Voice asks only for these.
const VOICE_FIELDS: readonly FieldSpec[] = [
  { key: 'deepgram_api_key', label: 'Deepgram API key', hint: 'speech to text' },
  { key: 'cartesia_api_key', label: 'Cartesia API key', hint: 'text to speech' },
  { key: 'cartesia_voice_id', label: 'Curia’s voice', hint: 'a Cartesia voice ID, from play.cartesia.ai', placeholder: 'a voice ID' },
];

export function VoiceStep({ task, principal, fields, contactId, onSaved, onContinue, onHelp }: RouteStepProps): JSX.Element {
  const { route, error, pick } = useRoute<VoiceRoute>('voice-route', fields.voiceRoute, async (next) => {
    await saveSetupFields({ voiceRoute: next });
  }, onSaved);
  const save = useSaveAndContinue(onContinue);

  return (
    <div>
      <h2>How will {principal} talk to Curia?</h2>
      <p className="setup-lede">Voice is required, so {principal} can choose a call or chat for any session.</p>
      <ChoiceGroup<VoiceRoute | 'phone'>
        label="Voice route"
        value={route}
        onChange={(next) => { if (next !== 'phone') void pick(next); }}
        options={[
          { value: 'app', title: 'In the Curia app', description: `${atSentenceStart(principal)} taps to call from the phone app or the console.`,
            tag: fields.messagingRoute === 'app' ? 'Matches messaging' : undefined },
          { value: 'signal', title: 'Signal call', description: `${atSentenceStart(principal)} calls Curia’s Signal number.`,
            tag: fields.messagingRoute === 'signal' ? 'Matches messaging' : undefined },
          // Telnyx phone calls are out of scope for #2358; shown so the gap is visible, not explained.
          { value: 'phone', title: 'Phone', description: 'Call Curia on a dedicated phone line (coming soon).', disabled: true },
        ]}
      />
      {error && <p className="setup-status attention" role="alert">{error}</p>}
      {route && (
        <ChannelCredentialsForm
          channel="voice"
          ref={save.register('voice')}
          fields={VOICE_FIELDS}
          incompleteNote="Saved. Voice also needs LiveKit’s keys, which come with Curia’s install; this install doesn’t have them yet."
          onChanged={onSaved}
        />
      )}
      {/* A Signal call needs the Signal channel itself; Messaging collects it when that is
          Signal too, so ask here only when it isn't. */}
      {route === 'signal' && fields.messagingRoute !== 'signal' && (
        <ChannelCredentialsForm ref={save.register('signal')} channel="signal" fields={ROUTE_FIELDS.signal} onChanged={onSaved} />
      )}
      {route === 'signal' && fields.messagingRoute !== 'signal' && (
        <PrincipalIdentityField
          contactId={contactId}
          channel="signal"
          ref={save.register('principal-signal')}
          label={`${atSentenceStart(principal)}’s Signal number`}
          placeholder="+14165550100"
          onChanged={onSaved}
        />
      )}
      {route && <TaskStatus task={task} />}
      <SaveAndContinue save={save} onHelp={onHelp} />
    </div>
  );
}
