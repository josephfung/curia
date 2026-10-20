// Types for external verifications (#2017): a third party wants proof from the
// principal before Curia can continue (first use: a site's sign-in code).

export type VerificationPurpose = 'sign_in';
export type VerificationKind = 'code';
export type VerificationDelivery = 'email' | 'sms' | 'app';
export type VerificationStatus = 'pending' | 'satisfied' | 'expired' | 'abandoned';

/** A verification row. The code value is never part of it. */
export interface Verification {
  id: string;
  purpose: VerificationPurpose;
  kind: VerificationKind;
  delivery: VerificationDelivery;
  /** Registrable domain of the site the principal asked about; the uniqueness key. */
  site: string;
  /** Registrable domain of the page showing the challenge (often an identity provider). */
  pageDomain: string;
  browserSessionId: string;
  taskId: string | null;
  conversationId: string | null;
  status: VerificationStatus;
  requestedAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface OpenVerificationInput {
  purpose: VerificationPurpose;
  kind: VerificationKind;
  delivery: VerificationDelivery;
  /** URL or host; stored as its registrable domain. */
  site: string;
  /** URL or host; stored as its registrable domain. */
  pageDomain: string;
  browserSessionId: string;
  taskId?: string;
  conversationId?: string;
  /** Defaults to `defaultExpiryMinutes` after the request. */
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface VerificationConfig {
  /** Channels to ask the principal on, in preference order. */
  askChannelOrder: string[];
  defaultExpiryMinutes: number;
  /** How long a closed verification still counts as recent. */
  recentWindowMinutes: number;
  /** How long a tracked code value lives after its verification closes. */
  codeTtlMinutesAfterClose: number;
  emailWaitSeconds: number;
  /**
   * Registrable domains of identity providers a site may embed its sign-in in. A child
   * frame holding the code input becomes the verification's page_domain only when it is
   * on the site's own domain or one of these.
   */
  identityProviderDomains: string[];
}
