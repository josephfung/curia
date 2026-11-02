import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api';
import { PAIRING_LIMIT_MESSAGE } from '../../../../../src/phone/phone-docs.js';
import { PhoneNotice } from '../../pwa/PhoneNotice';
import {
  invitationSummary,
  isMintedInvitation,
  readInvitationBody,
  shouldPollInvitation,
  type InvitationStatus,
  type MintedInvitation,
} from './invitation-state';
import { usePairOrigin } from './usePairOrigin';

const POLL_MS = 5000;

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}

/**
 * The phone app invitation link (#2412). The operator sends it to the
 * principal through their own channel. The link is shown only right after it
 * is minted, because only its hash is stored. After a reload the panel shows
 * the link's state, and a new link replaces it.
 */
export function InvitePhonePanel({ onPaired }: { onPaired?: () => void }) {
  const { choice, needsOrigin, originDraft, setOriginDraft, originError, checkDraft, commitDraft } = usePairOrigin();
  const [current, setCurrent] = useState<InvitationStatus | null | undefined>(undefined);
  const [minted, setMinted] = useState<MintedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  }, [onPaired]);
  const lastState = useRef<InvitationStatus['state'] | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/pairing/invitation');
    if (!res.ok) throw new Error('Could not read the invitation link.');
    const status = readInvitationBody(await res.json());
    if (status === undefined) throw new Error('Could not read the invitation link.');
    if (status?.state === 'redeemed' && lastState.current === 'waiting') onPairedRef.current?.();
    lastState.current = status?.state ?? null;
    setCurrent(status);
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not read the invitation link.');
    });
  }, [load]);

  useEffect(() => {
    if (!current || !shouldPollInvitation(current)) return;
    const poll = () => {
      if (document.hidden) return;
      load().catch((err: unknown) => {
        console.error('[invite] status poll failed:', err);
      });
    };
    const timer = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [current, load]);

  async function mint() {
    if (current?.state === 'waiting'
      && !window.confirm('The link you already made will stop working. Create a new one?')) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await apiFetch('/api/pairing/invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: commitDraft() }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 429) throw new Error(PAIRING_LIMIT_MESSAGE);
      if (!res.ok) throw new Error(errorMessage(body, 'Could not create an invitation link.'));
      if (!isMintedInvitation(body)) throw new Error('Could not create an invitation link.');
      setMinted(body);
      // The link is shown only once, so a failed refresh must not hide it.
      setCurrent({ id: body.id, state: 'waiting', expiresAt: body.expiresAt, redeemedAt: null, deviceName: null });
      lastState.current = 'waiting';
      await load().catch((err: unknown) => {
        console.error('[invite] status refresh failed:', err);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create an invitation link.');
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!window.confirm('Stop this invitation link? It will no longer sign a phone in.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/pairing/invitation', { method: 'DELETE' });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessage(body, 'Could not stop the invitation link.'));
      setMinted(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the invitation link.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch (err) {
      console.error('[invite] copy failed:', err);
      setError('Could not copy the link. Select it and copy it by hand.');
    }
  }

  const showLink = minted !== null && current?.id === minted.id && current.state === 'waiting';
  const warning = showLink ? minted.warning : (choice?.warning ?? null);
  const canCreate = !busy && originDraft.trim().length > 0;

  return (
    <section className="pair-panel">
      <h3 className="settings-section-title">Invite your principal</h3>
      <p className="settings-section-sub">
        A link that installs Curia on the principal's phone and signs it in. Send it yourself, in a text or a message, and ask them to open it in Safari or Chrome. It works once and lasts 48 hours. A new link stops the old one.
      </p>
      {warning && <PhoneNotice text={warning} />}
      {(error ?? originError) && <p className="autonomy-error" role="alert">{error ?? originError}</p>}

      {current && (
        <p className={current.state === 'redeemed' ? 'pair-paired' : 'device-meta'} role="status">
          {invitationSummary(current)}
        </p>
      )}

      {showLink && (
        <div className="pair-code">
          <input
            className="invite-link"
            aria-label="Invitation link"
            readOnly
            value={minted.pairUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="invite-actions">
            <button type="button" className="btn btn-primary" onClick={() => { void copy(minted.pairUrl); }}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
          <p className="device-meta">
            This is the only time the link is shown. If you lose it, create a new one.
          </p>
        </div>
      )}

      <form
        className="pair-form"
        onSubmit={(event) => {
          event.preventDefault();
          void mint();
        }}
      >
        {needsOrigin && (
          <label className="pair-origin">
            Phone address
            <input
              aria-label="Invitation phone address"
              placeholder="https://curia.example.com"
              value={originDraft}
              onChange={(event) => setOriginDraft(event.target.value)}
              onBlur={() => { void checkDraft(); }}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
        )}
        <div className="invite-actions">
          <button type="submit" className={current ? 'btn' : 'btn btn-primary'} disabled={!canCreate}>
            {busy ? 'Working…' : current ? 'Create a new link' : 'Create invitation link'}
          </button>
          {current?.state === 'waiting' && (
            <button type="button" className="btn" disabled={busy} onClick={() => { void stop(); }}>
              Stop link
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
