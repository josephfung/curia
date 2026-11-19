// What the Setup page reads and writes (#2358). Thin wrappers over the setup routes in
// src/channels/http/routes/setup.ts; each throws an Error carrying the server's message.

import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import type { Checklist } from './setup-steps.js';

export type SetupFor = 'self' | 'other';
export type MessagingRoute = 'app' | 'signal' | 'sms' | 'slack';
export type VoiceRoute = 'app' | 'signal';

/** GET /api/setup/status → `setup`. */
export interface SetupFields {
  setupFor: SetupFor | null;
  operatorName: string | null;
  operatorEmail: string | null;
  messagingRoute: MessagingRoute | null;
  voiceRoute: VoiceRoute | null;
}

/** GET /api/setup/principal. */
export interface PrincipalInfo {
  exists: boolean;
  contactId: string | null;
  displayName: string | null;
  timezone: string | null;
  title: string | null;
  pronouns: string | null;
  email: string | null;
}

export const EMPTY_SETUP_FIELDS: SetupFields = {
  setupFor: null, operatorName: null, operatorEmail: null, messagingRoute: null, voiceRoute: null,
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorMessage(res));
  return await res.json() as T;
}

export async function fetchChecklist(): Promise<Checklist> {
  return json<Checklist>(await apiFetch('/api/setup/checklist'));
}

export async function fetchSetupFields(): Promise<SetupFields> {
  const data = await json<{ setup?: SetupFields }>(await apiFetch('/api/setup/status'));
  return data.setup ?? EMPTY_SETUP_FIELDS;
}

export async function fetchPrincipal(): Promise<PrincipalInfo> {
  return json<PrincipalInfo>(await apiFetch('/api/setup/principal'));
}

/** PUT /api/setup/state: a partial update; null clears a field. */
export async function saveSetupFields(update: Partial<SetupFields>): Promise<SetupFields> {
  const data = await json<{ setup: SetupFields }>(await apiFetch('/api/setup/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }));
  return data.setup;
}

/** The Setup page opened: Setup has started, so web chat reaches the setup guide. */
export async function startSetup(): Promise<void> {
  await json<{ inSetup: boolean }>(await apiFetch('/api/setup/start', { method: 'POST' }));
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return json<T>(await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
