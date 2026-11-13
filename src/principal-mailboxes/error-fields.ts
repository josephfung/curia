// Log fields for errors on paths that handle principal-mailbox grant ids (#2475, R20).
// A Nylas SDK error can carry the grant id in its message or its own properties
// (NylasSdkTimeoutError.url is `…/grants/<id>`), so such errors are logged by class name and
// HTTP status only, never as `{ err }` (pino serializes own properties).

export interface GrantSafeErrorFields {
  errName: string;
  statusCode?: number;
}

/** Class name and HTTP status only: safe to log for any error, Nylas or not. */
export function grantSafeErrorFields(err: unknown): GrantSafeErrorFields {
  const errName = err instanceof Error ? err.name : typeof err;
  // The SDK sets statusCode; ceo-inbox's REST client (NylasApiError) sets status.
  const e = typeof err === 'object' && err !== null ? (err as { statusCode?: unknown; status?: unknown }) : undefined;
  const code = typeof e?.statusCode === 'number' ? e.statusCode : e?.status;
  return typeof code === 'number' ? { errName, statusCode: code } : { errName };
}

/**
 * True when the error may have come from the Nylas SDK (its class name, or the HTTP status /
 * request URL it attaches). Anything that is not an Error counts too: its shape is unknown.
 */
export function mayCarryGrantId(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  return err.name.startsWith('Nylas') || 'statusCode' in err || 'url' in err;
}

/**
 * What to tell the operator when a grant lookup failed, by its HTTP status (never its text):
 * 401/403 the API key was refused, 404 the grant is not in this Nylas app, a timeout or 5xx
 * means Nylas did not answer.
 */
export function grantLookupFailureDetail(err: unknown): string {
  const { errName, statusCode } = grantSafeErrorFields(err);
  if (statusCode === 401 || statusCode === 403) return 'Nylas rejected the API key (channel.email.nylas_api_key); check it in the console';
  if (statusCode === 404) return 'No such grant in this Nylas app; copy the grant ID again from the Nylas dashboard';
  if ((statusCode !== undefined && statusCode >= 500) || /timeout/i.test(errName)) return 'Nylas did not answer; try again in a moment';
  return 'The grant could not be read from Nylas';
}
