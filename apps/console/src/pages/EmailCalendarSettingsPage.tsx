import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { apiFetch } from '../api';
import { SettingsLayout } from './SettingsPage';
import { errorMessage } from '../components/settings/ConfigHistory';
import { PrincipalMailboxesSection } from '../components/PrincipalMailboxesSection';

// Settings → Personality → Email & Calendar (#2475): the principal's own mailboxes and the
// calendars read through them. Curia's own email accounts stay under Channels → Email.
//
// Every mailbox call goes through the email channel's Nylas API key, so without it the page
// lists the mailboxes read-only and points the operator at the channel. Whether the key is set
// comes from the channel status the Channels page already reads (GET /api/registry/channels,
// the email entry's nylas_api_key credential field: vault or env).

interface CredentialField { key: string; configured: boolean }
interface ChannelStatus { name: string; credentialFields: CredentialField[] }

type KeyState =
  | { kind: 'checking' }
  | { kind: 'set' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const EMAIL_CHANNEL_LINK = { to: '/channels', search: { channel: 'email' } } as const;

function EmailCalendarSection() {
  const [keyState, setKeyState] = useState<KeyState>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await apiFetch('/api/registry/channels');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { channels?: ChannelStatus[] };
        const email = (data.channels ?? []).find(c => c.name === 'email');
        const key = email?.credentialFields.find(f => f.key === 'nylas_api_key');
        if (!cancelled) setKeyState(key?.configured ? { kind: 'set' } : { kind: 'missing' });
      } catch (err) {
        console.error('[EmailCalendarSection] failed to read the email channel status:', err);
        if (!cancelled) {
          setKeyState({ kind: 'error', message: err instanceof Error ? err.message : 'unknown error' });
        }
      }
    }
    void check();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Email &amp; Calendar</h2>
        <p className="settings-page-sub">
          Your own email accounts and calendars, which Curia monitors for you. These are not the
          accounts Curia sends its own email from.
        </p>
        <p className="settings-page-sub">
          To change the email accounts Curia sends from, go to{' '}
          <Link {...EMAIL_CHANNEL_LINK}>Channels → Email</Link>.
        </p>
      </div>

      {keyState.kind === 'missing' && (
        <div className="dash-alert danger" role="alert" style={{ marginBottom: 20 }}>
          <div className="dash-alert-title">Finish setting up the email channel first</div>
          <div className="dash-alert-body">
            Curia reaches your mailboxes through the email channel&apos;s Nylas API key, which
            isn&apos;t saved yet. Save it under Channels → Email, restart Curia, then come back to add a mailbox.
          </div>
          <Link {...EMAIL_CHANNEL_LINK} className="btn btn-secondary btn-sm">Go to Channels → Email</Link>
        </div>
      )}
      {keyState.kind === 'error' && (
        <p className="autonomy-error" role="alert">
          Couldn&apos;t check whether the email channel is set up: {keyState.message}
        </p>
      )}

      <section className="settings-section">
        <div className="settings-section-body">
          {/* Read-only until the key is known to be set. A failed check leaves the controls on:
              the server still refuses a mailbox change it cannot make, with its own reason. */}
          <PrincipalMailboxesSection readOnly={keyState.kind === 'checking' || keyState.kind === 'missing'} />
        </div>
      </section>
    </>
  );
}

export function EmailCalendarPage() {
  return (
    <SettingsLayout activeSection="email-calendar">
      <EmailCalendarSection />
    </SettingsLayout>
  );
}

export default EmailCalendarPage;
