import { useEffect, useState } from 'react';
import { apiFetch } from '../../api';
import { readPairingOrigin, writePairingOrigin } from './pair-origin-memory';

export interface OriginChoice {
  origin: string | null;
  warning: string | null;
  askForOrigin: boolean;
}

function isOriginChoice(value: unknown): value is OriginChoice {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (row['origin'] === null || typeof row['origin'] === 'string')
    && (row['warning'] === null || typeof row['warning'] === 'string')
    && typeof row['askForOrigin'] === 'boolean';
}

/**
 * The address a phone should open, shared by the QR code and the invitation
 * link. When this desktop's own address can't host the app, the operator
 * types one, and it's remembered for next time.
 */
export function usePairOrigin() {
  const [choice, setChoice] = useState<OriginChoice | null>(null);
  const [needsOrigin, setNeedsOrigin] = useState(false);
  const [originDraft, setOriginDraft] = useState('');
  const [originError, setOriginError] = useState<string | null>(null);

  useEffect(() => {
    const desktopOrigin = window.location.origin;
    void apiFetch(`/api/pairing/origin?desktopOrigin=${encodeURIComponent(desktopOrigin)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not check this address.');
        const body: unknown = await res.json();
        if (!isOriginChoice(body)) throw new Error('Could not check this address.');
        setChoice(body);
        const ask = body.askForOrigin || !body.origin;
        setNeedsOrigin(ask);
        if (body.origin && !body.askForOrigin) setOriginDraft(body.origin);
        else {
          const saved = readPairingOrigin(window.localStorage);
          if (saved) setOriginDraft(saved);
        }
      })
      .catch((err: unknown) => {
        setOriginError(err instanceof Error ? err.message : 'Could not check this address.');
      });
  }, []);

  async function checkDraft() {
    const draft = originDraft.trim();
    if (!draft) return;
    writePairingOrigin(window.localStorage, draft);
    try {
      const res = await apiFetch(`/api/pairing/origin?requested=${encodeURIComponent(draft)}`);
      if (!res.ok) return;
      const body: unknown = await res.json();
      if (!isOriginChoice(body)) return;
      setChoice((current) => current
        ? { ...current, origin: body.origin, warning: body.warning }
        : body);
    } catch (err) {
      console.error('[pair] origin check failed:', err);
    }
  }

  /** The trimmed address to send, remembered for the next visit. */
  function commitDraft(): string {
    const draft = originDraft.trim();
    writePairingOrigin(window.localStorage, draft);
    return draft;
  }

  return { choice, needsOrigin, originDraft, setOriginDraft, originError, checkDraft, commitDraft };
}
