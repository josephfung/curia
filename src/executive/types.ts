// types.ts — Executive Profile types.
//
// These types define the shape of the executive (CEO) profile that is stored
// in the DB, loaded from config/executive-profile.yaml on first startup, and
// injected into agent system prompts via the ${executive_voice_block} token.
//
// Separation from OfficeIdentity is intentional:
//   OfficeIdentity     = how the assistant presents itself
//   ExecutiveProfile   = how the system represents the executive (style, preferences)
//
// The executive's identity (name, title, org) lives in the contact system —
// not here. This file is purely about preferences and style.

export interface ExecutiveProfile {
  writingVoice: WritingVoice;
}

export interface WritingVoice {
  /** Free-form tone descriptors (1–3). No predefined set — the executive's voice is personal. */
  tone: string[];
  /** 0–100; 0 = casual Slack DM, 100 = board letter. */
  formality: number;
  /** Short bullets describing how the executive writes. Ordered by importance. */
  patterns: string[];
  /** Words the executive prefers and avoids. */
  vocabulary: {
    prefer: string[];
    avoid: string[];
  };
  /** Email sign-off when drafting in the executive's voice. */
  signOff: string;
}

export interface ExecutiveProfileVersion {
  id: number;
  version: number;
  config: ExecutiveProfile;
  changedBy: string;
  note?: string;
  createdAt: Date;
}
