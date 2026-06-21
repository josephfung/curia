// resume-token.ts — shared encode/decode for delegate resume tokens.
//
// A resume token carries the context needed to resume a paused/blocked specialist task: the
// agent, its original brief, and a progress (or intent) note. Base64-encoded so it survives
// JSON round-trips through context_bridge metadata and the secret_capture_tokens row. Versioned
// for forward-compatible format changes. Holds NO secret material — names and NL only.

/** Version marker — allows forward-compatible format changes. */
export const RESUME_TOKEN_VERSION = 1;

/** Caps on variable-length fields so the base64 token fits the 16 KB context_bridge metadata
 *  budget (8 KB raw JSON → ~10.7 KB base64). */
export const MAX_RESUME_TASK_LENGTH = 2000;
export const MAX_RESUME_CONTEXT_LENGTH = 4000;

export interface ResumeTokenPayload {
  v: number;
  agent: string;
  original_task: string;
  context: string;
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** Build a base64 resume token, truncating over-budget fields with an ellipsis. */
export function encodeResumeToken(args: { agent: string; originalTask: string; context: string }): string {
  const payload: ResumeTokenPayload = {
    v: RESUME_TOKEN_VERSION,
    agent: args.agent,
    original_task: cap(args.originalTask, MAX_RESUME_TASK_LENGTH),
    context: cap(args.context, MAX_RESUME_CONTEXT_LENGTH),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** Decode a resume token. Returns null (NOT throws) when the token is not valid base64 JSON with
 *  the required string fields — callers MUST handle null and log, rather than trust a malformed
 *  token. Version is not enforced here (lenient decode); callers can inspect `.v` if they care. */
export function decodeResumeToken(token: string): ResumeTokenPayload | null {
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    // Malformed input is an expected, handled outcome (return null); not an error to propagate.
    return null;
  }
  if (
    typeof decoded.agent !== 'string' ||
    typeof decoded.original_task !== 'string' ||
    typeof decoded.context !== 'string'
  ) {
    return null;
  }
  const v = typeof decoded.v === 'number' ? decoded.v : RESUME_TOKEN_VERSION;
  // Validated above; cast through unknown per strict-TS narrowing rule.
  return { v, agent: decoded.agent, original_task: decoded.original_task, context: decoded.context } as unknown as ResumeTokenPayload;
}
