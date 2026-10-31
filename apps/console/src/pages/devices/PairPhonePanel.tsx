import { useEffect, useState } from 'react';
import { apiFetch } from '../../api';
import { PairingQr } from './PairingQr';

interface OriginChoice {
  origin: string | null;
  warning: string | null;
  askForOrigin: boolean;
}

interface MintedCode {
  pairUrl: string;
  shortCode: string;
  expiresAt: string;
  warning: string | null;
}

function isOriginChoice(value: unknown): value is OriginChoice {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (row['origin'] === null || typeof row['origin'] === 'string')
    && (row['warning'] === null || typeof row['warning'] === 'string')
    && typeof row['askForOrigin'] === 'boolean';
}

function isMintedCode(value: unknown): value is MintedCode {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['pairUrl'] === 'string'
    && typeof row['shortCode'] === 'string'
    && typeof row['expiresAt'] === 'string'
    && (row['warning'] === null || typeof row['warning'] === 'string');
}

export function PairPhonePanel() {
  const [choice, setChoice] = useState<OriginChoice | null>(null);
  const [originDraft, setOriginDraft] = useState('');
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const desktopOrigin = window.location.origin;
    void apiFetch(`/api/pairing/origin?desktopOrigin=${encodeURIComponent(desktopOrigin)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not check this address.');
        const body: unknown = await res.json();
        if (!isOriginChoice(body)) throw new Error('Could not check this address.');
        setChoice(body);
        if (body.origin && !body.askForOrigin) setOriginDraft(body.origin);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not check this address.');
      });
  }, []);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/pairing/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: originDraft.trim() }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'Could not create a pairing code.';
        throw new Error(message);
      }
      if (!isMintedCode(body)) throw new Error('Could not create a pairing code.');
      setMinted(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a pairing code.');
    } finally {
      setBusy(false);
    }
  }

  const warning = minted?.warning ?? choice?.warning ?? null;

  return (
    <section className="pair-panel">
      <h3 className="settings-section-title">Pair a phone</h3>
      <p className="settings-section-sub">
        Scan the code with the phone, or type the short code. The phone stays signed in for 90 days after its last use. The sign-in lives in the cookie, so add Curia to the home screen from the same browser that opened the link.
      </p>
      {warning && <p className="pair-warning" role="status">{warning}</p>}
      {error && <p className="autonomy-error">{error}</p>}
      {minted ? (
        <div className="pair-code">
          <PairingQr value={minted.pairUrl} />
          <p className="pair-short" aria-label="Short pairing code">{minted.shortCode}</p>
          <p className="device-meta">
            Expires {new Date(minted.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
            The QR works once, and the short code works once.
          </p>
        </div>
      ) : (
        <form
          className="pair-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mint();
          }}
        >
          {(choice?.askForOrigin || !choice?.origin) && (
            <label className="pair-origin">
              Phone address
              <input
                aria-label="Phone address"
                placeholder="https://curia.example.com"
                value={originDraft}
                onChange={(event) => setOriginDraft(event.target.value)}
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
