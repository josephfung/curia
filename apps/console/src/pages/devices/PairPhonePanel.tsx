import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api';
import { PAIRING_LIMIT_MESSAGE } from '../../../../../src/phone/phone-docs.js';
import { PhoneNotice } from '../../pwa/PhoneNotice';
import { PairingQr } from './PairingQr';
import { shouldStopPairingPoll } from './pairing-poll';
import { usePairOrigin } from './usePairOrigin';

interface MintedCode {
  id: string;
  pairUrl: string;
  shortCode: string;
  expiresAt: string;
  warning: string | null;
}

interface PairingStatus {
  tokenRedeemed: boolean;
  shortRedeemed: boolean;
  expired: boolean;
  tokenDeviceName: string | null;
  shortDeviceName: string | null;
}

function isMintedCode(value: unknown): value is MintedCode {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && typeof row['pairUrl'] === 'string'
    && typeof row['shortCode'] === 'string'
    && typeof row['expiresAt'] === 'string'
    && (row['warning'] === null || typeof row['warning'] === 'string');
}

function isPairingStatus(value: unknown): value is PairingStatus {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['tokenRedeemed'] === 'boolean'
    && typeof row['shortRedeemed'] === 'boolean'
    && typeof row['expired'] === 'boolean'
    && (row['tokenDeviceName'] === null || typeof row['tokenDeviceName'] === 'string')
    && (row['shortDeviceName'] === null || typeof row['shortDeviceName'] === 'string');
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}

export function PairPhonePanel({ onPaired }: { onPaired?: () => void }) {
  const { choice, needsOrigin, originDraft, setOriginDraft, originError, checkDraft, commitDraft } = usePairOrigin();
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seen = useRef({ token: false, short: false });
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  }, [onPaired]);

  useEffect(() => {
    if (!minted) return;
    let stop = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const halt = () => {
      stop = true;
      if (timer !== undefined) clearInterval(timer);
    };
    const poll = () => {
      if (stop || document.hidden || inFlight) return;
      inFlight = true;
      void apiFetch(`/api/pairing/codes/${minted.id}`)
        .then(async (res) => {
          if (stop) return;
          if (res.status === 404) {
            halt();
            return;
          }
          if (!res.ok) return;
          const body: unknown = await res.json();
          if (!isPairingStatus(body)) return;
          setStatus(body);
          if (body.tokenRedeemed && !seen.current.token) {
            seen.current.token = true;
            onPairedRef.current?.();
          }
          if (body.shortRedeemed && !seen.current.short) {
            seen.current.short = true;
            onPairedRef.current?.();
          }
          if (shouldStopPairingPoll(res.status, body)) halt();
        })
        .catch((err: unknown) => {
          console.error('[pair] status poll failed:', err);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    poll();
    timer = setInterval(poll, 2000);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      halt();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [minted]);

  async function mint() {
    setBusy(true);
    setError(null);
    const draft = commitDraft();
    try {
      const res = await apiFetch('/api/pairing/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: draft }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 429) throw new Error(PAIRING_LIMIT_MESSAGE);
      if (!res.ok) throw new Error(errorMessage(body, 'Could not create a pairing code.'));
      if (!isMintedCode(body)) throw new Error('Could not create a pairing code.');
      seen.current = { token: false, short: false };
      setStatus(null);
      setMinted(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a pairing code.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMinted(null);
    setStatus(null);
  }

  const warning = minted ? minted.warning : (choice?.warning ?? null);
  const redeemed = Boolean(status?.tokenRedeemed || status?.shortRedeemed);
  const showQr = minted !== null && !redeemed && !status?.expired;

  return (
    <section className="pair-panel">
      <h3 className="settings-section-title">Pair a phone</h3>
      <p className="settings-section-sub">
        Scan the code with the phone, or type the short code. The phone stays signed in for 90 days after its last use. The sign-in lives in the cookie, so add Curia to the home screen from the same browser that opened the link.
      </p>
      {warning && <PhoneNotice text={warning} />}
      {(error ?? originError) && <p className="autonomy-error" role="alert">{error ?? originError}</p>}
      {minted ? (
        <div className="pair-code">
          {showQr && <PairingQr value={minted.pairUrl} />}
          {status?.tokenRedeemed && (
            <p className="pair-paired" role="status">
              QR · Paired ✓{status.tokenDeviceName ? ` · ${status.tokenDeviceName}` : ''}
            </p>
          )}
          {status?.shortRedeemed && (
            <p className="pair-paired" role="status">
              Short code · Paired ✓{status.shortDeviceName ? ` · ${status.shortDeviceName}` : ''}
            </p>
          )}
          {redeemed ? (
            <button type="button" className="btn" onClick={reset}>Create another code</button>
          ) : status?.expired ? (
            <button type="button" className="btn" onClick={reset}>Expired · Create a new code</button>
          ) : (
            <>
              <p className="pair-short" aria-label="Short pairing code">{minted.shortCode}</p>
              <p className="device-meta">
                Expires {new Date(minted.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
                The QR works once, and the short code works once.
              </p>
            </>
          )}
        </div>
      ) : (
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
                aria-label="Phone address"
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
          <button type="submit" className="btn btn-primary" disabled={busy || originDraft.trim().length === 0}>
            {busy ? 'Creating…' : 'Create pairing code'}
          </button>
        </form>
      )}
    </section>
  );
}
