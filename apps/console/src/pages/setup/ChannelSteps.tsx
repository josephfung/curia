// The channel steps (#2358): Email, Messaging, Voice, and Email & calendar. Each takes its
// credentials inline (ChannelForms.tsx) and shows its live check from the Setup checklist.
// Messaging and Voice also save the route the operator picks, which their checks read.
import { useEffect, useRef, useState, type JSX } from 'react';
import { ConnectWithGoogle } from '../../components/ConnectWithGoogle.js';
import { EmailAccountsSection } from '../../components/EmailAccountsSection.js';
import { NylasSignInSetupSection } from '../../components/NylasSignInSetupSection.js';
import { saveSetupFields, type MessagingRoute, type SetupFields, type VoiceRoute } from './setup-api.js';
import { atSentenceStart, createLatestSaver, type ChecklistTask } from './setup-steps.js';
import { ChoiceGroup, StatusLine, StepFooter } from './setup-ui.js';
import { ChannelCredentialsForm, PrincipalIdentityField, turnOnChannelIfReady, type FieldSpec } from './ChannelForms.js';

const DOCS_ORIGIN = 'https://docs.meetcuria.com';

interface StepProps {
  task: ChecklistTask | undefined;
  principal: string;
  onSaved: () => Promise<void>;
  onContinue: () => void;
  onHelp?: () => void;
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
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
    </div>
  );
}

export function SignInStep({ task, principal, onSaved, onContinue, onHelp }: StepProps): JSX.Element {
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
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
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
    { key: 'phone_number', label: 'Curia’s Signal number', placeholder: '+1 416 555 0142' },
    { key: 'socket_path', label: 'Signal server socket', hint: 'where signal-cli listens', placeholder: '/var/run/signal-cli/socket' },
  ],
  sms: [
    { key: 'api_key', label: 'Telnyx API key' },
    { key: 'from_number', label: 'Curia’s number', placeholder: '+1 416 555 0188' },
    { key: 'webhook_public_key', label: 'Telnyx webhook public key' },
  ],
  slack: [
    { key: 'bot_token', label: 'Slack bot token', placeholder: 'xoxb-…' },
    { key: 'app_token', label: 'Slack app-level token', placeholder: 'xapp-…' },
  ],
};

const IDENTITY_LABEL: Record<Exclude<MessagingRoute, 'app'>, { noun: string; placeholder: string }> = {
  signal: { noun: 'Signal number', placeholder: '+1 416 555 0100' },
  sms: { noun: 'mobile number', placeholder: '+1 416 555 0100' },
  slack: { noun: 'Slack member ID', placeholder: 'U0123ABCD' },
};

/**
 * The route saved one pick at a time, newest last (createLatestSaver). While a pick is
 * unsaved the screen shows it; otherwise it follows what is stored, so a failed save shows
 * the stored route again. The step stays mounted across refreshes, so keyboard focus holds.
 */
function useRoute<T extends string>(storedRoute: T | null, save: (next: T) => Promise<void>, onSaved: () => Promise<void>) {
  const [route, setRoute] = useState<T | null>(storedRoute);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(0);
  const stored = useRef(storedRoute);
  stored.current = storedRoute;
  // The latest save, not the first render's: Messaging's reads the current voice route.
  const latestSave = useRef(save);
  latestSave.current = save;
  const saver = useRef(createLatestSaver((next: T) => latestSave.current(next))).current;
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
  const { route, error, pick } = useRoute<MessagingRoute>(fields.messagingRoute, async (next) => {
    // Voice follows messaging until the operator picks it: Signal for Signal, else the app.
    await saveSetupFields({
      messagingRoute: next,
      ...(fields.voiceRoute === null ? { voiceRoute: next === 'signal' ? 'signal' : 'app' } : {}),
    });
  }, onSaved);

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
          <ChannelCredentialsForm key={route} channel={route} fields={ROUTE_FIELDS[route]} onChanged={onSaved} />
          <PrincipalIdentityField
            key={`id-${route}`}
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
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
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
  const { route, error, pick } = useRoute<VoiceRoute>(fields.voiceRoute, async (next) => {
    await saveSetupFields({ voiceRoute: next });
  }, onSaved);

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
      {route && <ChannelCredentialsForm channel="voice" fields={VOICE_FIELDS} onChanged={onSaved} />}
      {/* A Signal call needs the Signal channel itself; Messaging collects it when that is
          Signal too, so ask here only when it isn't. */}
      {route === 'signal' && fields.messagingRoute !== 'signal' && (
        <ChannelCredentialsForm channel="signal" fields={ROUTE_FIELDS.signal} onChanged={onSaved} />
      )}
      {route === 'signal' && fields.messagingRoute !== 'signal' && (
        <PrincipalIdentityField
          contactId={contactId}
          channel="signal"
          label={`${atSentenceStart(principal)}’s Signal number`}
          placeholder="+1 416 555 0100"
          onChanged={onSaved}
        />
      )}
      {route && <TaskStatus task={task} />}
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
    </div>
  );
}
