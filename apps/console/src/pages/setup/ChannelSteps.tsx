// The channel steps (#2358): Email, Messaging, Voice, and Email & calendar. Each shows its
// live check from the Setup checklist. Messaging and Voice also save the route the operator
// picks, which their checks read. Credentials are entered on the Settings page each step
// links to; the steps' own forms replace those links in a later PR.
import { useEffect, useRef, useState, type JSX } from 'react';
import { saveSetupFields, type MessagingRoute, type SetupFields, type VoiceRoute } from './setup-api.js';
import { atSentenceStart, createLatestSaver, type ChecklistTask } from './setup-steps.js';
import { ChoiceGroup, StatusLine, StepFooter } from './setup-ui.js';

const DOCS_ORIGIN = 'https://docs.meetcuria.com';

interface StepProps {
  task: ChecklistTask | undefined;
  principal: string;
  onContinue: () => void;
  onHelp?: () => void;
}

/** The step's live check, its how-to, and where to enter the credentials. */
function TaskBlock(props: { task: ChecklistTask | undefined; settingsPath: string; settingsLabel: string }): JSX.Element {
  const { task } = props;
  return (
    <>
      {task?.status === 'done' && <StatusLine kind="ok">Done.</StatusLine>}
      {task && task.status !== 'done' && (
        <StatusLine kind={task.restart_required ? 'attention' : 'neutral'}>
          {task.restart_required ? 'Saved. Turns on when you apply and restart at the end.' : task.detail ?? 'Not set up yet.'}
        </StatusLine>
      )}
      {task?.credential_how_to && <div className="setup-note">{task.credential_how_to}</div>}
      <div className="setup-actions">
        <a href={props.settingsPath} className="btn btn-secondary">{props.settingsLabel}</a>
        {task?.docs_url && (
          <a className="setup-link" href={`${DOCS_ORIGIN}${task.docs_url}`} target="_blank" rel="noopener noreferrer">Setup guide</a>
        )}
      </div>
    </>
  );
}

export function EmailStep({ task, onContinue, onHelp }: StepProps): JSX.Element {
  return (
    <div>
      <h2>Curia’s own email</h2>
      <p className="setup-lede">A dedicated mailbox Curia sends and receives from. Add your Nylas API key, then connect Curia’s mailbox.</p>
      <TaskBlock task={task} settingsPath="/channels?channel=email" settingsLabel="Open email settings" />
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
    </div>
  );
}

export function SignInStep({ task, principal, onContinue, onHelp }: StepProps): JSX.Element {
  return (
    <div>
      <h2>{atSentenceStart(principal)}’s email and calendar</h2>
      <p className="setup-lede">
        Lets {principal} connect their own Google account by signing in, with no grant IDs to copy. It uses the Nylas key from the Email step.
        A connected mailbox isn’t needed to finish Setup: {principal} can connect it in the first conversation.
      </p>
      <TaskBlock task={task} settingsPath="/settings/email-calendar" settingsLabel="Open email & calendar settings" />
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
    </div>
  );
}

interface RouteStepProps extends StepProps {
  fields: SetupFields;
  onSaved: () => Promise<void>;
}

const MESSAGING_CHOICES: Array<{ id: MessagingRoute; title: string; desc: (p: string) => string; tag?: string }> = [
  { id: 'app', title: 'Curia app', desc: (p) => `Installs on ${p}’s phone from a link. No phone number needed.`, tag: 'Recommended' },
  { id: 'signal', title: 'Signal', desc: () => 'For someone who already uses Signal. Needs a number for Curia.' },
  { id: 'sms', title: 'Text message (SMS)', desc: () => 'Works on any phone. Needs a Telnyx number.' },
  { id: 'slack', title: 'Slack', desc: () => 'For someone who lives in Slack. Needs Curia’s Slack app in their workspace.' },
];

// Where each route's credentials and the principal's id are entered until the step has its form.
const MESSAGING_SETTINGS: Record<MessagingRoute, { path: string; label: string }> = {
  app: { path: '/system/devices', label: 'Open devices' },
  signal: { path: '/channels?channel=signal', label: 'Open Signal settings' },
  sms: { path: '/channels?channel=sms', label: 'Open SMS settings' },
  slack: { path: '/channels?channel=slack', label: 'Open Slack settings' },
};

export function MessagingStep({ task, principal, fields, onSaved, onContinue, onHelp }: RouteStepProps): JSX.Element {
  const [route, setRoute] = useState<MessagingRoute | null>(fields.messagingRoute);
  const [error, setError] = useState<string | null>(null);
  // Picks not yet saved. While any is pending the screen shows the newest pick; otherwise it
  // follows what is stored, so a failed save shows the stored route again. The step stays
  // mounted across refreshes, so keyboard focus is never lost mid-choice.
  const pending = useRef(0);
  const stored = useRef(fields.messagingRoute);
  stored.current = fields.messagingRoute;
  useEffect(() => {
    if (pending.current === 0) setRoute(fields.messagingRoute);
  }, [fields.messagingRoute]);
  // One save at a time, the newest choice last (see createLatestSaver).
  const save = useRef(createLatestSaver(async (next: MessagingRoute) => {
    // Voice follows messaging until the operator picks it: Signal for Signal, else the app.
    await saveSetupFields({
      messagingRoute: next,
      ...(fields.voiceRoute === null ? { voiceRoute: next === 'signal' ? 'signal' : 'app' } : {}),
    });
  })).current;

  async function pick(next: MessagingRoute): Promise<void> {
    setRoute(next);
    setError(null);
    pending.current++;
    let failed = false;
    try {
      await save(next);
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
      {route && route !== 'app' && (
        <p className="setup-hint">Add {principal}’s {route === 'slack' ? 'Slack member ID' : route === 'sms' ? 'mobile number' : 'Signal number'} on their contact (Contacts). Nothing is sent to {principal}.</p>
      )}
      {route && <TaskBlock task={task} settingsPath={MESSAGING_SETTINGS[route].path} settingsLabel={MESSAGING_SETTINGS[route].label} />}
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
    </div>
  );
}

export function VoiceStep({ task, principal, fields, onSaved, onContinue, onHelp }: RouteStepProps): JSX.Element {
  const [route, setRoute] = useState<VoiceRoute | null>(fields.voiceRoute);
  const [error, setError] = useState<string | null>(null);
  // Picks not yet saved. While any is pending the screen shows the newest pick; otherwise it
  // follows what is stored, so a failed save shows the stored route again. The step stays
  // mounted across refreshes, so keyboard focus is never lost mid-choice.
  const pending = useRef(0);
  const stored = useRef(fields.voiceRoute);
  stored.current = fields.voiceRoute;
  useEffect(() => {
    if (pending.current === 0) setRoute(fields.voiceRoute);
  }, [fields.voiceRoute]);
  // One save at a time, the newest choice last (see createLatestSaver).
  const save = useRef(createLatestSaver(async (next: VoiceRoute) => {
    await saveSetupFields({ voiceRoute: next });
  })).current;

  async function pick(next: VoiceRoute | 'phone'): Promise<void> {
    if (next === 'phone') return; // Shown as coming soon; never selectable.
    setRoute(next);
    setError(null);
    pending.current++;
    let failed = false;
    try {
      await save(next);
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

  return (
    <div>
      <h2>How will {principal} talk to Curia?</h2>
      <p className="setup-lede">Voice is required, so {principal} can choose a call or chat for any session.</p>
      <ChoiceGroup
        label="Voice route"
        value={route}
        onChange={(next) => void pick(next)}
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
      {route && <TaskBlock task={task} settingsPath="/channels?channel=voice" settingsLabel="Open voice settings" />}
      <StepFooter primary="Continue" onPrimary={onContinue} onHelp={onHelp} />
    </div>
  );
}
