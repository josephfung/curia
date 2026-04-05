// types.ts — Office Identity types for the Curia instance.
//
// These types define the shape of the identity config that is stored in the DB,
// loaded from config/office-identity.yaml on first startup, and injected into
// the coordinator system prompt via the ${office_identity_block} token.

export interface OfficeIdentity {
  assistant: {
    name: string;
    title: string;
    emailSignature: string;
  };
  tone: {
    // 1–3 words from BASELINE_TONE_OPTIONS. Validated at the application layer.
    // Not a DB enum — extend BASELINE_TONE_OPTIONS without a migration.
    baseline: string[];
    verbosity: number;    // 0–100; 0 = tersest, 100 = most thorough
    directness: number;   // 0–100; 0 = most hedged, 100 = most direct
  };
  behavioralPreferences: string[];
  decisionStyle: {
    externalActions: 'conservative' | 'balanced' | 'proactive';
    internalAnalysis: 'conservative' | 'balanced' | 'proactive';
  };
  constraints: string[];
}

export interface OfficeIdentityVersion {
  id: number;
  version: number;
  config: OfficeIdentity;
  changedBy: string;
  note?: string;
  createdAt: Date;
}

// Predefined set for tone.baseline. Validated at the application layer.
// To add a new word: extend this constant and bump the app — no migration needed.
export const BASELINE_TONE_OPTIONS = [
  // Warmth / Relationship
  'warm', 'friendly', 'approachable', 'personable', 'empathetic',
  'encouraging', 'gracious', 'caring',
  // Efficiency / Edge
  'direct', 'blunt', 'candid', 'frank', 'matter-of-fact', 'no-nonsense',
  // Energy / Register
  'energetic', 'calm', 'composed', 'enthusiastic', 'steady', 'measured',
  // Personality / Color
  'playful', 'witty', 'dry', 'charming', 'diplomatic', 'tactful',
  'thoughtful', 'curious',
  // Authority / Gravitas
  'confident', 'assured', 'polished', 'authoritative', 'professional',
] as const;

export type BaselineToneOption = typeof BASELINE_TONE_OPTIONS[number];
