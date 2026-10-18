// types.ts — Office Identity types for the Curia instance.
//
// These types define the shape of the identity config that is stored in the DB,
// seeded from src/identity/defaults.ts on first startup, and injected into
// the coordinator system prompt via the ${office_identity_block} token.

export interface OfficeIdentity {
  assistant: {
    name: string;
    title: string;
    emailSignature: string;
  };
  tone: {
    /**
     * How the assistant sounds, in the operator's words, usually started from a console
     * template ending in an example line. 1–TONE_STYLE_MAX_LENGTH chars. Rendered verbatim.
     */
    style: string;
    verbosity: number;    // the Detail slider: 0–100; 0 = tersest, 100 = most thorough
  };
  behavioralPreferences: string[];
  constraints: string[];
}

/** The longest `tone.style` the identity accepts. */
export const TONE_STYLE_MAX_LENGTH = 800;

export interface OfficeIdentityVersion {
  id: number;
  version: number;
  config: OfficeIdentity;
  changedBy: string;
  note?: string;
  createdAt: Date;
}
