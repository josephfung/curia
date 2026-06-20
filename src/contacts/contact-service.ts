// src/contacts/contact-service.ts
//
// ContactService: CRUD operations for contacts and their channel identities,
// with automatic KG person-node creation and identity auto-verification.
//
// Follows the backend-interface pattern from WorkingMemory / KnowledgeGraphStore:
// - Private constructor, static factory methods
// - InMemoryContactBackend for tests, PostgresContactBackend for production
// - Business logic (auto-verify, KG linking) lives in ContactService,
//   backends are pure storage

import { randomUUID } from 'node:crypto';
import type { DbPool, DbPoolClient } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import { sanitizeDisplayName } from '../skills/sanitize.js';
import { TIER_RANK, IdentityNotFoundError } from './types.js';
import type {
  AuthOverride,
  Contact,
  ContactCanonicalFields,
  ContactTier,
  ContactKind,
  ChannelIdentity,
  ContactServiceOptions,
  CreateContactOptions,
  DedupConfidence,
  DuplicatePair,
  GrantRecommendation,
  GrantRecommendationStatus,
  LinkIdentityOptions,
  MergeGoldenRecord,
  MergeProposal,
  MergeResult,
  ResolvedSender,
  IdentitySource,
  IdentityStatus,
  SystemRole,
} from './types.js';
import type { DedupService } from './dedup-service.js';
import type { ContactCalendar, CreateCalendarLinkOptions, ResolvedCalendar } from './calendar-types.js';

/** Thrown when a caller provides invalid data for a contact field (e.g., primaryEmail not in CCI). */
export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationError';
  }
}

/**
 * A contact is "structural" when it represents a fixed part of the system topology
 * rather than an ordinary correspondent: the principal, an agent, or anything with a
 * non-null system_role. Such rows must never be deleted by a merge and a structural
 * primary's tier must never be downgraded by survivorship. Exported for unit testing.
 */
export function isStructuralContact(c: Contact): boolean {
  return c.systemRole !== null || c.kind === 'principal' || c.kind === 'agent' || c.tier === 'principal';
}

// ---------------------------------------------------------------------------
// Email sender classification (issue #946)
// ---------------------------------------------------------------------------
// Helpers to decide whether an email sender should be stored as a person or
// routed to an organization KG node. Exported for unit testing.

/** Well-known personal webmail domains that should never generate org nodes. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.ca',
  'outlook.com',
  'live.com', 'live.ca', 'live.co.uk',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'msn.com',
  'protonmail.com', 'proton.me', 'pm.me',
]);

/**
 * Local-part prefixes that are unambiguously machine-generated: no-reply addresses,
 * mailing-system roles, bounce handlers, unsubscribe addresses.
 * Checked first — before the webmail-domain check — so noreply@gmail.com is
 * correctly classified as automated rather than person.
 */
const AUTOMATED_LOCAL_RE =
  /^(no[_.-]?reply|noreply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)$/i;

/**
 * Local-part prefixes that belong to an org role address (support, billing, etc.)
 * but are NOT unambiguously automated. Matches → classify as organization.
 * hello/news kept here: too ambiguous to call automated (could be a real team).
 */
const NON_PERSON_LOCAL_RE =
  /^(info|support|hello|help|admin|contact|billing|feedback|news|team|sales|marketing|legal|security|service|services|order|orders|invoice|invoices|accounts?|system)$/i;

/**
 * Local-part pattern for a personal name address (first.last or first_last).
 * Two alphabetic words separated by a dot, underscore, or hyphen.
 */
const PERSON_LOCAL_RE = /^[a-zA-Z]+[._-][a-zA-Z]+$/;

/**
 * Classify an email sender as a person, an organization role address, or an
 * automated/bulk sender.
 *
 * Rules applied in order:
 * 1. Automated local-part pattern → 'automated' (checked BEFORE webmail domain
 *    so noreply@gmail.com is automated, not person)
 * 2. Personal webmail domain → 'person'
 * 3. Org/system role local-part pattern → 'organization'
 * 4. Local part looks like first.last name → 'person'
 * 5. Default → 'person' (conservative; false negative on org is less harmful
 *    than merging a real person under an org node)
 */
export function classifyEmailSender(email: string): 'person' | 'organization' | 'automated' {
  const atIdx = email.indexOf('@');
  if (atIdx === -1) return 'person'; // malformed — safe default

  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1).toLowerCase();

  if (AUTOMATED_LOCAL_RE.test(localPart)) return 'automated';
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return 'person';
  if (NON_PERSON_LOCAL_RE.test(localPart)) return 'organization';
  if (PERSON_LOCAL_RE.test(localPart)) return 'person';
  return 'person'; // default
}

/**
 * Derive a human-readable label from an email domain.
 * Strips the TLD and capitalizes: 'github.com' → 'Github', 'stripe.io' → 'Stripe'.
 */
function deriveOrgLabelFromDomain(domain: string): string {
  const name = domain.split('.')[0] ?? domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// -- Backend interface --

interface ContactServiceBackend {
  createContact(contact: Contact): Promise<void>;
  getContact(id: string): Promise<Contact | undefined>;
  findContactByName(name: string): Promise<Contact[]>;
  findContactByKgNodeId(kgNodeId: string): Promise<Contact | null>;
  findContactByRole(role: string): Promise<Contact[]>;
  findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null>;
  listContacts(filters?: { tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]>;
  updateContact(contact: Contact, client?: DbPoolClient): Promise<void>;
  createIdentity(identity: ChannelIdentity): Promise<void>;
  getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]>;
  resolveByChannelIdentity(channel: string, channelIdentifier: string): Promise<ResolvedSender | null>;
  unlinkIdentity(identityId: string): Promise<boolean>;
  setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity>;

  /**
   * Atomically elevate a contact's tier from 'unknown' to 'known'.
   * Guards against automated/agent kinds at DB level.
   * Returns true if the row was updated, false otherwise (already elevated, wrong tier, or excluded kind).
   */
  elevateTierToKnown(contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment'): Promise<boolean>;

  getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>>;
  createAuthOverride(override: AuthOverride): Promise<void>;
  revokeAuthOverride(contactId: string, permission: string): Promise<boolean>;

  // -- Grant recommendations (issue #952) --
  createGrantRecommendation(rec: GrantRecommendation): Promise<void>;
  getGrantRecommendation(id: string): Promise<GrantRecommendation | null>;
  findGrantRecommendation(contactId: string, permission: string): Promise<GrantRecommendation | null>;
  listGrantRecommendations(filters?: { status?: GrantRecommendationStatus; limit?: number }): Promise<GrantRecommendation[]>;
  resolveGrantRecommendation(id: string, status: 'approved' | 'declined', resolvedBy: string): Promise<boolean>;
  createCalendarLink(calendar: ContactCalendar): Promise<void>;
  deleteCalendarLink(nylasCalendarId: string): Promise<boolean>;
  getCalendarsForContact(contactId: string): Promise<ContactCalendar[]>;
  resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null>;
  getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null>;

  /**
   * Re-point all channel identities from fromContactId → toContactId.
   * Identities that would violate UNIQUE(channel, channelIdentifier) are deleted.
   */
  reattachIdentities(fromContactId: string, toContactId: string): Promise<void>;

  /**
   * Re-point active auth overrides from fromContactId → toContactId.
   * If primary already has an override for the same permission, secondary's is discarded.
   */
  reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void>;

  /**
   * Delete a contact by ID. Call only after FK-referenced rows have been re-pointed.
   */
  deleteContact(id: string): Promise<void>;

  /**
   * Update scoring-owned fields on a contact. Uses atomic increments for message
   * counts to avoid read-modify-write races. Only touches scoring-owned columns —
   * does not modify display_name, role, status, notes, or trust_level.
   */
  updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void>;
}

// -- Auto-verification sources --
// Per spec: ceo_stated, email_participant, crm_import, calendar_attendee are auto-verified.
// signal_participant is also auto-verified — Signal's phone-number identity is stronger than
// email (no header spoofing), so we trust the source number at the same level as email_participant.
// agent_called is auto-verified — the agent extracted the identifier mechanically from the channel
// (e.g. an email sender address), not from LLM-generated content. Same trust level as email_participant.
// Only self_claimed starts unverified and cannot be force-verified.
const AUTO_VERIFIED_SOURCES: ReadonlySet<IdentitySource> = new Set([
  'ceo_stated',
  'email_participant',
  'signal_participant',
  'crm_import',
  'calendar_attendee',
  'agent_called',
]);

/**
 * ContactService manages the lifecycle of contacts and their channel identities.
 *
 * Key behaviors:
 * - Auto-creates a KG person node when a contact is created (if entityMemory is available
 *   and no kgNodeId is provided)
 * - Auto-verifies identities from trusted sources (ceo_stated, email_participant, etc.)
 * - Resolves inbound senders by channel + identifier for dispatch routing
 */
export class ContactService {
  private onContactMerged?: (primaryId: string, secondaryId: string, mergedAt: Date) => void;
  private onIdentityVerified?: (contactId: string) => void;
  private onContactElevated?: (contactId: string, reason: 'correspondence' | 'domain-validated' | 'judgment') => void;
  private dedupService?: DedupService;
  private onDuplicateDetected?: (
    newContactId: string,
    matchContactId: string,
    confidence: DedupConfidence,
    reason: string,
  ) => void;

  private constructor(
    private backend: ContactServiceBackend,
    private entityMemory: EntityMemory | undefined,
    private logger?: Logger,
    options?: ContactServiceOptions,
  ) {
    this.onContactMerged = options?.onContactMerged;
    this.onIdentityVerified = options?.onIdentityVerified;
    this.onContactElevated = options?.onContactElevated;
    this.dedupService = options?.dedupService;
    this.onDuplicateDetected = options?.onDuplicateDetected;
  }

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(
    pool: DbPool,
    entityMemory: EntityMemory | undefined,
    logger: Logger,
    options?: ContactServiceOptions,
  ): ContactService {
    return new ContactService(new PostgresContactBackend(pool, logger), entityMemory, logger, options);
  }

  /** Create an in-memory instance for testing */
  static createInMemory(entityMemory?: EntityMemory, options?: ContactServiceOptions): ContactService {
    return new ContactService(new InMemoryContactBackend(), entityMemory, undefined, options);
  }

  /**
   * For a business email address, resolve or create an organization KG node and
   * return its ID along with the 'organization' kind. Returns null when the sender
   * should be treated as a person (personal webmail domain, firstname.lastname address,
   * or no entityMemory available).
   *
   * @param email          The sender's email address (used for classification + domain lookup)
   * @param safeName       Sanitized display name (used as org label when human-readable)
   * @param rawDisplayName Original display name before sanitization (used to detect email-shaped names)
   * @param source         Provenance tag for newly created KG nodes
   *
   * Resolution order:
   *   1. classifyEmailSender() → null if person
   *   2. findEntities(domain) filtered to 'organization' → existing node
   *   3. findEntities(safeName) filtered to 'organization' → existing node (human-readable names only)
   *   4. createEntity('organization') → new node
   */
  private async resolveOrCreateOrgNode(
    email: string,
    safeName: string,
    rawDisplayName: string,
    source: string,
  ): Promise<{ kgNodeId: string; kind: ContactKind } | null> {
    if (!this.entityMemory) return null;

    if (classifyEmailSender(email) !== 'organization') return null;

    const atIdx = email.indexOf('@');
    if (atIdx === -1) return null;
    // Normalise to lowercase so 'Github.com' and 'github.com' resolve to the same node.
    const domain = email.slice(atIdx + 1).toLowerCase();

    try {
      // Try domain as label (e.g. 'github.com' → existing 'github.com' org node)
      const domainMatches = await this.entityMemory.findEntities(domain);
      const domainOrg = domainMatches.find((n) => n.type === 'organization');
      if (domainOrg) return { kgNodeId: domainOrg.id, kind: 'organization' };

      // The raw display name (before sanitization) tells us whether the caller used a
      // human-readable name like "GitHub" or fell back to the email address itself.
      // Sanitization strips '@', so the safe check is on the pre-sanitization value.
      const rawIsEmailShaped = rawDisplayName.includes('@');

      if (!rawIsEmailShaped) {
        // Try the human-readable display name as a label
        const nameMatches = await this.entityMemory.findEntities(safeName);
        const nameOrg = nameMatches.find((n) => n.type === 'organization');
        if (nameOrg) return { kgNodeId: nameOrg.id, kind: 'organization' };
      }

      // Create a new organization node. Use the human-readable display name when
      // available; otherwise derive a label from the domain.
      const orgLabel = rawIsEmailShaped ? deriveOrgLabelFromDomain(domain) : safeName;
      const { entity } = await this.entityMemory.createEntity({
        type: 'organization',
        label: orgLabel,
        properties: { domain },
        source,
      });
      return { kgNodeId: entity.id, kind: 'organization' };
    } catch (err) {
      // Programming errors (wrong arg types, shape mismatches) indicate a bug and
      // should propagate rather than being silently swallowed as a "KG is down" case.
      if (err instanceof TypeError || err instanceof RangeError) throw err;

      // KG I/O failures (DB unavailable, transient network error) are best-effort:
      // fall through to person-node creation rather than blocking contact creation.
      this.logger?.error(
        { err, email, domain, step: 'resolveOrCreateOrgNode' },
        'resolveOrCreateOrgNode: KG operation failed — falling back to person node',
      );
      return null;
    }
  }

  /**
   * Create a new contact. If entityMemory is available and no kgNodeId is provided,
   * auto-creates or resolves a KG node and links it to the contact. When primaryEmail
   * is set and classifies as an org sender, routes to an organization KG node instead
   * of minting a person node.
   */
  async createContact(options: CreateContactOptions): Promise<Contact> {
    const now = new Date();

    // Defense-in-depth: sanitize display names at storage time to prevent
    // stored prompt injection. External sources (email participants, CRM imports)
    // may contain arbitrary content in the name field. See issue #39.
    const safeName = sanitizeDisplayName(
      options.displayName,
      options.fallbackDisplayName,
    );

    // Log when sanitization modifies a display name — important for debugging
    // "why is this contact named X?" questions and for audit-trailing blocked
    // prompt injection attempts.
    if (safeName !== options.displayName && this.logger) {
      // Truncate and strip newlines from the raw value before logging to prevent
      // log injection (a crafted name with embedded newlines + JSON could forge
      // synthetic log entries in line-oriented log viewers).
      const safeOriginal = options.displayName.slice(0, 500).replace(/[\r\n]/g, '\\n');
      this.logger.warn(
        { original: safeOriginal, sanitized: safeName, source: options.source },
        'Display name was modified by sanitization',
      );
    }

    // Resolve a KG node. Priority:
    //   1. Explicit kgNodeId provided by caller — use as-is (no lookup needed)
    //   2. primaryEmail classifies as automated → set kind='automated', skip KG org node
    //   3. primaryEmail set and classifies as org → resolveOrCreateOrgNode()
    //   4. Fall through to person-node auto-creation
    let kgNodeId: string | null = options.kgNodeId ?? null;
    let resolvedKind: ContactKind = options.kind ?? 'person';

    if (!kgNodeId && this.entityMemory) {
      if (options.primaryEmail) {
        // Automated senders (noreply, mailer-daemon, etc.) have no org node worth linking.
        // Skip resolveOrCreateOrgNode entirely and set kind directly. The person-node
        // fallback below will still run so the contact gets a KG node, just a person-type one.
        if (classifyEmailSender(options.primaryEmail) === 'automated') {
          resolvedKind = 'automated';
          this.logger?.debug(
            { email: options.primaryEmail, requestedKind: options.kind },
            'createContact: automated sender — skipping org KG node',
          );
        } else {
          const orgResult = await this.resolveOrCreateOrgNode(
            options.primaryEmail,
            safeName,
            options.displayName,
            options.source,
          );
          if (orgResult) {
            kgNodeId = orgResult.kgNodeId;
            resolvedKind = orgResult.kind;
            if (options.kind && options.kind !== orgResult.kind) {
              // Warn when caller explicitly passed a kind that was overridden — this
              // is likely a caller bug (e.g. passing kind:'person' for an org email).
              this.logger?.warn(
                { requestedKind: options.kind, resolvedKind: orgResult.kind, email: options.primaryEmail },
                'createContact: org routing overrode caller-supplied kind',
              );
            } else {
              // Debug trace on every org routing application so misclassifications
              // are detectable retroactively even when kind defaulted to 'person'.
              this.logger?.debug(
                { resolvedKind: orgResult.kind, email: options.primaryEmail },
                'createContact: org routing applied',
              );
            }
          }
        }
      }

      // If no org node was resolved, auto-create a person KG node as before.
      if (!kgNodeId) {
        const { entity, created } = await this.entityMemory.createEntity({
          type: 'person',
          label: safeName,
          properties: options.role ? { role: options.role } : {},
          source: options.source,
        });
        if (!created && options.role) {
          // A KG node already existed for this label. Apply the role property if
          // it isn't already set — the existing node may have been created without
          // one (e.g. by extract-relationships which always passes empty properties).
          const { node } = await this.entityMemory.updateNode(entity.id, {
            properties: { ...entity.properties, role: options.role },
          });
          kgNodeId = node.id;
        } else {
          kgNodeId = entity.id;
        }

        // Org routing did not fire or returned null (KG transient failure), so we fell
        // back to a person node. Downgrade kind to 'person' to match the node type.
        // Note: kind='automated' is intentionally left unchanged here — automated contacts
        // use person-type KG nodes by design; the downgrade guard only applies to org routing.
        if (resolvedKind === 'organization') {
          this.logger?.warn(
            { requestedKind: options.kind, email: options.primaryEmail },
            'createContact: org routing did not resolve an org node — downgrading kind to person',
          );
          resolvedKind = 'person';
        }
      }
    }

    // Tier for new contacts. If `tier` is explicitly provided, use it directly.
    // Otherwise default to 'known' (the former status='confirmed' default).
    //
    // 'trusted' and 'principal' are capability grants, not creation-time states:
    // 'trusted' is a deliberate CEO grant (#952) and 'principal' is structural
    // (derived from system_role, set by bootstrap). Enforce that invariant here so a
    // caller cannot mint a high-capability contact in a single createContact() call —
    // a contact must be created at a lower tier and elevated explicitly afterwards.
    if (options.tier === 'trusted' || options.tier === 'principal') {
      throw new ContactValidationError(
        `createContact cannot create a contact directly at tier '${options.tier}'; ` +
          `create at 'known'/'unknown'/'blocked' and elevate via setTier()/grant or bootstrap.`,
      );
    }
    const contactTier: ContactTier = options.tier ?? 'known';

    // Derive kind: org routing in resolveOrCreateOrgNode() takes precedence over
    // the caller-supplied kind, which in turn overrides the 'person' default.
    const contactKind: ContactKind = resolvedKind;

    const contact: Contact = {
      id: randomUUID(),
      kgNodeId,
      displayName: safeName,
      role: options.role ?? null,
      // system_role is set only by bootstrap via direct SQL or updateContact; new contacts
      // created through the normal flow always start with null and get assigned explicitly.
      systemRole: null,
      tier: contactTier,
      kind: contactKind,
      // Trust scoring fields default to zero/null on creation; updated by the scoring pipeline
      contactConfidence: 0,
      lastSeenAt: null,
      inboundMessageCount: 0,
      outboundMessageCount: 0,
      notes: options.notes ?? null,
      createdAt: now,
      updatedAt: now,
      // Canonical fields (migration 048)
      preferredName: options.preferredName ?? null,
      title: options.title ?? null,
      organization: options.organization ?? null,
      primaryEmail: options.primaryEmail?.toLowerCase() ?? null,
      primaryPhone: options.primaryPhone ?? null,
      timezone: options.timezone ?? null,
      locale: options.locale ?? null,
      location: options.location ?? null,
      pronouns: options.pronouns ?? null,
      linkedinUrl: options.linkedinUrl ?? null,
      bio: options.bio ?? null,
      birthday: options.birthday ?? null,
    };

    try {
      await this.backend.createContact(contact);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const constraint = (err as { constraint?: string }).constraint;
      // idx_contacts_kg_node_unique (partial unique index on kg_node_id) fires when
      // upsertNode returned an existing kg_node that is already claimed by another
      // contact — e.g. two people both named "Alice Smith". Retry without a KG link;
      // the two contacts can be merged later via the contact-merge flow.
      if (pgCode === '23505' && constraint === 'idx_contacts_kg_node_unique') {
        // Downgrade kind to 'person' alongside stripping the KG link — but only if the
        // contact was an org contact, to avoid violating the invariant that org contacts
        // are always linked to a KG org node. Automated contacts keep their kind even
        // without a KG link (their person-type node may still be around; the link is just
        // lost for this contact instance due to the collision).
        this.logger?.warn(
          { contactId: contact.id, kgNodeId: contact.kgNodeId, contactKind: contact.kind },
          'KG node already claimed by another contact — creating contact without KG link; org kind downgraded to person',
        );
        contact.kgNodeId = null;
        if (contact.kind === 'organization') {
          contact.kind = 'person';
        }
        try {
          await this.backend.createContact(contact);
        } catch (retryErr) {
          // The retry itself failed — log with context so the caller can distinguish
          // a double-collision (astronomically rare) from a transient DB error.
          this.logger?.error(
            { err: retryErr, contactId: contact.id, step: 'createContact_kg_collision_retry' },
            'Contact creation failed on retry after KG collision',
          );
          throw retryErr;
        }
      } else {
        // TODO: The KG node auto-created above is now orphaned — it exists in the knowledge
        // graph with no corresponding contact row. Clean up once EntityMemory exposes a
        // delete method. For now the orphan is harmless (person node with no contact link).
        this.logger?.error({ err, contactId: contact.id }, 'Contact creation failed');
        throw err;
      }
    }

    // Fire-and-forget dedup check. Runs asynchronously — never blocks the create.
    // A failure here is logged and swallowed; it must not fail the contact creation.
    // Capture references before the closure so TypeScript narrowing is preserved
    // and no non-null assertions (!!) are needed inside the async callback.
    const { dedupService, onDuplicateDetected } = this;
    if (dedupService && onDuplicateDetected) {
      setImmediate(async () => {
        try {
          const allContacts = await this.backend.listContacts();
          const others = allContacts.filter((c) => c.id !== contact.id);
          const identitiesMap = new Map<string, ChannelIdentity[]>();
          for (const c of others) {
            identitiesMap.set(c.id, await this.backend.getIdentitiesForContact(c.id));
          }
          const newIdentities = await this.backend.getIdentitiesForContact(contact.id);
          const pairs = dedupService.checkForDuplicates(
            contact,
            newIdentities,
            others,
            identitiesMap,
          );
          for (const pair of pairs) {
            const matchId = pair.contactB.id === contact.id ? pair.contactA.id : pair.contactB.id;
            try {
              onDuplicateDetected(contact.id, matchId, pair.confidence, pair.reason);
            } catch (callbackErr) {
              this.logger?.warn({ err: callbackErr }, 'onDuplicateDetected callback threw (ignored)');
            }
          }
        } catch (err) {
          this.logger?.warn({ err, contactId: contact.id }, 'Dedup check failed (non-fatal)');
        }
      });
    }

    return contact;
  }

  /** Retrieve a contact by ID. Returns undefined if not found. */
  async getContact(id: string): Promise<Contact | undefined> {
    return this.backend.getContact(id);
  }

  /** Find contacts by display name (case-insensitive exact match). */
  async findContactByName(name: string): Promise<Contact[]> {
    return this.backend.findContactByName(name);
  }

  /** Find a contact by the KG node ID it is linked to. Returns null if not found. */
  async findContactByKgNodeId(kgNodeId: string): Promise<Contact | null> {
    return this.backend.findContactByKgNodeId(kgNodeId);
  }

  /** Find contacts by role. */
  async findContactByRole(role: string): Promise<Contact[]> {
    return this.backend.findContactByRole(role);
  }

  /** Find the single contact with the given system role, or null. */
  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    return this.backend.findContactBySystemRole(systemRole);
  }

  /** List contacts, optionally filtered by tier, kind, and/or capped by limit with offset for pagination. */
  async listContacts(filters?: { tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]> {
    return this.backend.listContacts(filters);
  }

  /**
   * Scan all contacts for probable duplicates.
   *
   * Fetches all contacts and their identities, then delegates to DedupService
   * for scoring. Returns empty list if no DedupService is wired.
   *
   * @param minConfidence - filter threshold (default: 'probable')
   */
  async findDuplicates(minConfidence: DedupConfidence = 'probable'): Promise<DuplicatePair[]> {
    if (!this.dedupService) {
      this.logger?.warn('findDuplicates() called but no DedupService wired — returning empty');
      return [];
    }
    try {
      const contacts = await this.backend.listContacts();
      const identitiesMap = new Map<string, ChannelIdentity[]>();
      for (const c of contacts) {
        identitiesMap.set(c.id, await this.backend.getIdentitiesForContact(c.id));
      }
      return this.dedupService.findAllDuplicates(contacts, identitiesMap, minConfidence);
    } catch (err) {
      // Log context before rethrowing — the skill handler's error will reference the raw
      // backend error with no indication it came from a full-contact-list scan.
      this.logger?.error({ err }, 'findDuplicates() failed during contact scan');
      throw err;
    }
  }

  /**
   * Sanitize the display name before persisting any contact update.
   * Defense-in-depth: catches names that were stored before the creation-time
   * sanitization gate (PR #63), and ensures any future update path that
   * routes through here cannot bypass sanitization. See issue #64 / #39.
   */
  private async updateStoredContact(contact: Contact, client?: DbPoolClient): Promise<Contact> {
    const safeName = sanitizeDisplayName(contact.displayName);
    const updatedContact =
      safeName === contact.displayName
        ? contact
        : {
            ...contact,
            displayName: safeName,
          };

    if (safeName !== contact.displayName && this.logger) {
      const safeOriginal = contact.displayName.slice(0, 500).replace(/[\r\n]/g, '\\n');
      this.logger.warn(
        { contactId: contact.id, original: safeOriginal, sanitized: safeName },
        'Display name was modified by sanitization during contact update',
      );
    }

    await this.backend.updateContact(updatedContact, client);
    return updatedContact;
  }

  /**
   * Persist a fully-constructed Contact in one write, applying display-name sanitization.
   *
   * Use this when the caller has already assembled all pending field changes in memory
   * and wants a single transactional write rather than the per-field read+write cycle
   * that individual setters (setTier, updateDisplayName, etc.) perform internally.
   *
   * Pass an optional PoolClient to participate in a caller-managed transaction.
   */
  async saveContact(contact: Contact, client?: DbPoolClient): Promise<Contact> {
    return this.updateStoredContact(contact, client);
  }

  /**
   * Update a contact's display name with sanitization.
   * This is the only sanctioned way to change a display name after creation —
   * callers must go through this method so the sanitization gate is enforced.
   */
  async updateDisplayName(contactId: string, displayName: string, client?: DbPoolClient): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      displayName,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated, client);
  }

  /** Update a contact's role and updatedAt timestamp. */
  async setRole(contactId: string, role: string, client?: DbPoolClient): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      role,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated, client);
  }

  /**
   * Link a channel identity to a contact.
   *
   * Auto-verification logic: sources ceo_stated, email_participant, crm_import,
   * and calendar_attendee are auto-verified. self_claimed starts unverified.
   * If options.verified is explicitly provided, that takes precedence.
   */
  async linkIdentity(options: LinkIdentityOptions): Promise<ChannelIdentity> {
    // Validate the contact exists before creating an identity for it.
    // Postgres would catch this via FK constraint, but the in-memory backend
    // would silently create a dangling reference without this check.
    const contact = await this.backend.getContact(options.contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${options.contactId}`);
    }

    const now = new Date();

    // Determine verification status: explicit override > auto-verify logic
    let verified: boolean;
    if (options.verified !== undefined) {
      verified = options.verified;
    } else {
      verified = AUTO_VERIFIED_SOURCES.has(options.source);
    }

    // Prevent force-verifying self-claimed identities — they must go through
    // the CEO confirmation flow to become verified.
    if (options.source === 'self_claimed' && verified) {
      throw new Error('Cannot force-verify a self_claimed identity — CEO confirmation required');
    }

    // Normalize email addresses to lowercase for case-insensitive matching.
    // RFC 5321 allows case-sensitive local-parts, but in practice no major
    // provider enforces this — storing mixed-case causes lookup misses when
    // the LLM or inbound adapter uses a different casing.
    const normalizedIdentifier = options.channel === 'email'
      ? options.channelIdentifier.toLowerCase()
      : options.channelIdentifier;

    const identity: ChannelIdentity = {
      id: randomUUID(),
      contactId: options.contactId,
      channel: options.channel,
      channelIdentifier: normalizedIdentifier,
      label: options.label ?? null,
      verified,
      verifiedAt: verified ? now : null,
      status: options.status ?? 'active',
      source: options.source,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createIdentity(identity);

    // Fire-and-forget: notify scoring pipeline when a verified identity is linked.
    // The callback may return a promise (async pipeline update), so we handle both
    // sync throws and async rejections. Scoring is non-blocking — must not fail
    // the linkIdentity operation.
    if (verified && this.onIdentityVerified) {
      try {
        const maybePromise = this.onIdentityVerified(options.contactId) as void | Promise<void>;
        // Handle async callbacks — catch unhandled rejections
        if (maybePromise instanceof Promise) {
          maybePromise.catch(err => {
            this.logger?.warn({ err, contactId: options.contactId }, 'onIdentityVerified callback rejected (non-fatal)');
          });
        }
      } catch (err) {
        this.logger?.warn({ err, contactId: options.contactId }, 'onIdentityVerified callback threw (non-fatal)');
      }
    }

    return identity;
  }

  /**
   * Resolve an inbound sender by channel + identifier.
   * Joins contacts with contact_channel_identities to find the matching contact.
   * Returns null if no match.
   */
  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    return this.backend.resolveByChannelIdentity(channel, channelIdentifier);
  }

  /** Get a contact together with all its linked channel identities. */
  async getContactWithIdentities(
    id: string,
  ): Promise<{ contact: Contact; identities: ChannelIdentity[] } | undefined> {
    const contact = await this.backend.getContact(id);
    if (!contact) {
      return undefined;
    }

    const identities = await this.backend.getIdentitiesForContact(id);
    return { contact, identities };
  }

  /**
   * Directly set a contact's tier. Accepts the four user-settable tiers only
   * (blocked/unknown/known/trusted); 'principal' is structural and must not be
   * hand-set — enforce that guard at the API layer before calling this method.
   *
   * Pass an optional PoolClient to participate in a caller-managed transaction.
   */
  async setTier(contactId: string, tier: ContactTier, client?: DbPoolClient): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      tier,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated, client);
  }

  /**
   * Directly set a contact's kind. Accepts the three user-settable kinds only
   * (person/organization/automated); 'principal' and 'agent' are structural —
   * enforce that guard at the API layer before calling this method.
   *
   * Pass an optional PoolClient to participate in a caller-managed transaction.
   */
  async setKind(contactId: string, kind: ContactKind, client?: DbPoolClient): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const updated: Contact = {
      ...contact,
      kind,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated, client);
  }

  /**
   * Validate that `primaryEmail` is present in `contact_channel_identities` for this
   * contact (channel = 'email', case-insensitive). Throws `ContactValidationError` if not.
   * Call this before any writes when the PATCH handler needs to reject invalid emails
   * without producing partial mutations.
   */
  async validatePrimaryEmail(contactId: string, primaryEmail: string): Promise<void> {
    const identities = await this.backend.getIdentitiesForContact(contactId);
    const emailLower = primaryEmail.toLowerCase();
    const match = identities.find(
      (i) => i.channel === 'email' && i.channelIdentifier.toLowerCase() === emailLower,
    );
    if (!match) {
      throw new ContactValidationError(
        `primaryEmail '${primaryEmail}' not found in contact_channel_identities for contact ${contactId}`,
      );
    }
  }

  /**
   * Update canonical profile attributes on a contact.
   *
   * Only fields present in `fields` are changed — absent keys leave the current
   * value untouched. If `fields.primaryEmail` is non-null, validates that the
   * email exists in `contact_channel_identities` for this contact (channel = 'email'),
   * case-insensitively. Throws with a descriptive message if not found.
   */
  async updateContactFields(
    contactId: string,
    fields: ContactCanonicalFields,
    client?: DbPoolClient,
  ): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    // Validate primaryEmail against channel identities before writing.
    if (fields.primaryEmail != null) {
      const identities = await this.backend.getIdentitiesForContact(contactId);
      const emailLower = fields.primaryEmail.toLowerCase();
      const match = identities.find(
        (i) => i.channel === 'email' && i.channelIdentifier.toLowerCase() === emailLower,
      );
      if (!match) {
        throw new ContactValidationError(
          `primaryEmail '${fields.primaryEmail}' not found in contact_channel_identities for contact ${contactId}`,
        );
      }
    }

    // Filter undefined entries — spreading undefined values would clear existing columns on
    // a partial PATCH (Object spread copies undefined keys, which overwrite non-undefined values).
    const definedFields = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as ContactCanonicalFields;

    // Normalize primaryEmail to lowercase for consistent storage and CCI comparison.
    if (definedFields.primaryEmail != null) {
      definedFields.primaryEmail = definedFields.primaryEmail.toLowerCase();
    }

    const updated: Contact = {
      ...contact,
      ...definedFields,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated, client);
  }

  /**
   * Atomically elevate a contact from tier='unknown' to tier='known'.
   * No-op for automated/agent kinds (enforced by backend SQL) and contacts already
   * at known/trusted/principal/blocked. Non-throwing — returns false on error.
   */
  async elevateTierToKnown(
    contactId: string,
    reason: 'correspondence' | 'domain-validated' | 'judgment',
  ): Promise<boolean> {
    try {
      const elevated = await this.backend.elevateTierToKnown(contactId, reason);
      if (elevated) {
        this.logger?.info({ contactId, reason }, 'contacts: tier elevated to known');
        if (this.onContactElevated) {
          try {
            this.onContactElevated(contactId, reason);
          } catch (callbackErr) {
            this.logger?.warn({ err: callbackErr }, 'onContactElevated callback threw (non-fatal)');
          }
        }
      }
      return elevated;
    } catch (err) {
      this.logger?.warn({ err, contactId, reason }, 'contacts: elevateTierToKnown failed (non-fatal)');
      return false;
    }
  }

  /** List all channel identities linked to a contact, oldest first. */
  async getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]> {
    return this.backend.getIdentitiesForContact(contactId);
  }

  /** Remove a channel identity by its ID. Returns true if found and removed, false if not found. */
  async unlinkIdentity(identityId: string): Promise<boolean> {
    return this.backend.unlinkIdentity(identityId);
  }

  /** Update the status of a channel identity (active, defunct, bounced). */
  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    return this.backend.setIdentityStatus(identityId, status);
  }

  /** Get active (non-revoked) auth overrides for a contact. */
  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    return this.backend.getAuthOverrides(contactId);
  }

  /**
   * Grant or deny a specific permission for a contact.
   * Uses upsert — if an active override already exists for this contact+permission,
   * it gets replaced.
   */
  async grantPermission(contactId: string, permission: string, granted: boolean, grantedBy: string): Promise<void> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const override: AuthOverride = {
      id: randomUUID(),
      contactId,
      permission,
      granted,
      grantedBy,
      createdAt: new Date(),
      revokedAt: null,
    };

    await this.backend.createAuthOverride(override);
  }

  /** Soft-revoke an auth override for a specific contact+permission. Returns true if an active override was found and revoked, false if nothing matched. */
  async revokePermission(contactId: string, permission: string): Promise<boolean> {
    return this.backend.revokeAuthOverride(contactId, permission);
  }

  // ---- Grant recommendations (issue #952) ----

  /**
   * Create a new grant recommendation for a contact+permission pair.
   * Returns false (no-op) when a recommendation already exists for this pair —
   * the caller must check first if dedup is desired at the service layer.
   */
  async createGrantRecommendation(
    contactId: string,
    permission: string,
    reasoning: string,
  ): Promise<{ created: boolean; recommendation: GrantRecommendation }> {
    const existing = await this.backend.findGrantRecommendation(contactId, permission);
    if (existing) {
      return { created: false, recommendation: existing };
    }

    const rec: GrantRecommendation = {
      id: randomUUID(),
      contactId,
      permission,
      reasoning,
      status: 'pending',
      suggestedAt: new Date(),
      resolvedAt: null,
      resolvedBy: null,
    };
    await this.backend.createGrantRecommendation(rec);
    this.logger?.info({ contactId, permission }, 'contacts: grant recommendation created');
    return { created: true, recommendation: rec };
  }

  /** Fetch a single grant recommendation by ID. */
  async getGrantRecommendation(id: string): Promise<GrantRecommendation | null> {
    return this.backend.getGrantRecommendation(id);
  }

  /** List grant recommendations, optionally filtered by status. */
  async listGrantRecommendations(
    filters?: { status?: GrantRecommendationStatus; limit?: number },
  ): Promise<GrantRecommendation[]> {
    return this.backend.listGrantRecommendations(filters);
  }

  /**
   * Approve a pending grant recommendation.
   * Also writes the contact_auth_overrides row so the permission takes effect immediately.
   * Returns false if the recommendation was not found or not in 'pending' status.
   */
  async approveGrantRecommendation(id: string, actorId: string): Promise<boolean> {
    const rec = await this.backend.getGrantRecommendation(id);
    if (!rec || rec.status !== 'pending') return false;

    // Grant the permission before resolving the recommendation, so any failure
    // here leaves the recommendation pending (retryable) rather than approved-but-not-granted.
    await this.grantPermission(rec.contactId, rec.permission, true, actorId);
    const resolved = await this.backend.resolveGrantRecommendation(id, 'approved', actorId);
    if (resolved) {
      this.logger?.info({ id, contactId: rec.contactId, permission: rec.permission, actorId }, 'contacts: grant recommendation approved');
    }
    return resolved;
  }

  /**
   * Decline a pending grant recommendation.
   * The row is permanently retained in 'declined' state as an anti-nag ledger entry —
   * the recommendation engine must check for declined rows before suggesting again.
   * Returns false if the recommendation was not found or not in 'pending' status.
   */
  async declineGrantRecommendation(id: string, actorId: string): Promise<boolean> {
    const rec = await this.backend.getGrantRecommendation(id);
    if (!rec || rec.status !== 'pending') return false;

    const resolved = await this.backend.resolveGrantRecommendation(id, 'declined', actorId);
    if (resolved) {
      this.logger?.info({ id, contactId: rec.contactId, permission: rec.permission, actorId }, 'contacts: grant recommendation declined (anti-nag recorded)');
    }
    return resolved;
  }

  /**
   * Link a calendar to a contact (or null for org-wide calendars).
   * Validates the contact exists (if contactId is non-null) and enforces
   * uniqueness on nylas_calendar_id and at-most-one-primary-per-contact.
   */
  async linkCalendar(options: CreateCalendarLinkOptions): Promise<ContactCalendar> {
    // Validate the contact exists if a contactId is provided
    if (options.contactId !== null) {
      const contact = await this.backend.getContact(options.contactId);
      if (!contact) {
        throw new Error(`Contact not found: ${options.contactId}`);
      }
    }

    const now = new Date();
    const calendar: ContactCalendar = {
      id: randomUUID(),
      nylasCalendarId: options.nylasCalendarId,
      contactId: options.contactId,
      label: options.label,
      isPrimary: options.isPrimary ?? false,
      readOnly: options.readOnly ?? false,
      timezone: options.timezone ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createCalendarLink(calendar);
    return calendar;
  }

  /** Remove a calendar association by its Nylas calendar ID. */
  async unlinkCalendar(nylasCalendarId: string): Promise<boolean> {
    return this.backend.deleteCalendarLink(nylasCalendarId);
  }

  /** Get all calendars linked to a contact. */
  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    return this.backend.getCalendarsForContact(contactId);
  }

  /** Resolve a Nylas calendar ID to its registry entry. Returns null if unregistered. */
  async resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null> {
    return this.backend.resolveCalendar(nylasCalendarId);
  }

  /** Get the primary calendar for a contact. Returns null if no primary is set. */
  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    return this.backend.getPrimaryCalendar(contactId);
  }

  /**
   * Merge secondary contact into primary.
   *
   * Golden record survivorship rules:
   * - display_name, role: most-recent-wins (primary wins on tie)
   * - notes: concatenate with separator
   * - tier: blocked-on-either-side wins (most restrictive); otherwise the higher TIER_RANK
   * - channel identities: union (duplicates discarded)
   * - auth overrides: union (primary wins on same-permission conflict)
   * - KG nodes: merged via entityMemory.mergeEntities() (Phase 1: scalar + facts)
   *
   * @param dryRun - if true, return proposal without writing (default: false)
   */
  async mergeContacts(
    primaryId: string,
    secondaryId: string,
    dryRun = false,
  ): Promise<MergeProposal | MergeResult> {
    if (primaryId === secondaryId) {
      throw new Error('primary_contact_id and secondary_contact_id must be different');
    }

    const primary = await this.backend.getContact(primaryId);
    if (!primary) throw new Error(`Contact not found: ${primaryId}`);
    const secondary = await this.backend.getContact(secondaryId);
    if (!secondary) throw new Error(`Contact not found: ${secondaryId}`);

    // Structural-contact guard. A merge writes the golden record onto the primary and
    // deletes the secondary, but it only copies scalar fields (tier/displayName/role/
    // notes) — never system_role/kind. So deleting a structural contact (the principal,
    // an agent, or anything with a system_role) via merge would destroy that structural
    // row entirely. Refuse to merge a structural contact as the *secondary*, regardless
    // of the primary — a structural→structural merge is just as destructive as
    // structural→non-structural. If two rows really are the same structural entity, the
    // structural one must be the primary (the survivor).
    if (isStructuralContact(secondary)) {
      throw new Error(
        `Cannot merge structural contact ${secondaryId} (principal/agent/system-role) — a merge ` +
          `deletes the secondary, which would destroy the structural row. Make it the primary instead.`,
      );
    }

    const primaryIdentities = await this.backend.getIdentitiesForContact(primaryId);
    const secondaryIdentities = await this.backend.getIdentitiesForContact(secondaryId);
    const primaryOverrides = await this.backend.getAuthOverrides(primaryId);
    const secondaryOverrides = await this.backend.getAuthOverrides(secondaryId);

    const goldenRecord = this.computeGoldenRecord(
      primary, primaryIdentities, primaryOverrides,
      secondary, secondaryIdentities, secondaryOverrides,
    );

    if (dryRun) {
      return { primaryContactId: primaryId, secondaryContactId: secondaryId, goldenRecord, dryRun: true };
    }

    // Merge KG nodes (best-effort — failure does not abort the contact merge)
    if (primary.kgNodeId && secondary.kgNodeId && this.entityMemory) {
      try {
        await this.entityMemory.mergeEntities(primary.kgNodeId, secondary.kgNodeId);
      } catch (err) {
        this.logger?.warn({ err, primaryId, secondaryId, primaryKgNodeId: primary.kgNodeId, secondaryKgNodeId: secondary.kgNodeId }, 'KG node merge failed (non-fatal)');
      }
    }

    try {
      await this.backend.reattachIdentities(secondaryId, primaryId);
      await this.backend.reattachAuthOverrides(secondaryId, primaryId);

      // Write the golden record fields onto the primary contact. The surviving tier
      // is computed by computeGoldenRecord (blocked-on-either-side wins; else higher
      // TIER_RANK) — the single source of survivorship truth. Rationale: tier
      // represents a CEO grant (e.g. the CEO explicitly trusted a secondary contact).
      // Merging should never silently downgrade that grant — losing a 'trusted' tier
      // because the primary happened to be 'known' is incorrect, especially since
      // #944's dedup calls mergeContacts. A 'blocked' tier on either side always wins
      // so a merge can never un-block a contact.
      const updatedPrimary: Contact = {
        ...primary,
        displayName: goldenRecord.displayName,
        role: goldenRecord.role,
        notes: goldenRecord.notes,
        tier: goldenRecord.tier,
        updatedAt: new Date(),
      };
      await this.backend.updateContact(updatedPrimary);
      await this.backend.deleteContact(secondaryId);
    } catch (err) {
      this.logger?.error({ err, primaryId, secondaryId }, 'Contact merge write failed — DB may be in partial state');
      throw err;
    }

    const mergedAt = new Date();

    if (this.onContactMerged) {
      try {
        this.onContactMerged(primaryId, secondaryId, mergedAt);
      } catch (callbackErr) {
        // The merge is already fully committed at this point — swallow the callback error
        // so the caller sees a successful merge result rather than a spurious failure.
        this.logger?.warn({ err: callbackErr }, 'onContactMerged callback threw (non-fatal, merge already committed)');
      }
    }

    this.logger?.info({ primaryId, secondaryId }, 'Contacts merged');

    return {
      primaryContactId: primaryId,
      secondaryContactId: secondaryId,
      goldenRecord,
      dryRun: false,
      mergedAt,
    };
  }

  /**
   * Delete a contact by ID. Should only be called after any FK-referenced rows
   * (identities, auth overrides) have been re-pointed or deleted, otherwise the
   * DB will reject with a foreign-key constraint error.
   *
   * Primarily used during contact merge (to remove the secondary) and during
   * error recovery (to remove orphaned contacts created by a failed identify).
   */
  async deleteContact(id: string): Promise<void> {
    await this.backend.deleteContact(id);
  }

  /**
   * Update scoring-owned fields. Delegates to the backend's atomic increment path.
   * Called by ConfidencePipeline — not intended for direct use by skills or other callers.
   */
  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    // Reject NaN/Infinity — these would silently corrupt the DB or cause a Postgres error
    // depending on the column type. Better to fail loudly here than silently at write-time.
    if (!Number.isFinite(updates.contactConfidence)) {
      throw new Error(`contact-service: contactConfidence must be a finite number, got ${updates.contactConfidence}`);
    }
    // Clamp to [0, 1] as a last-resort safety net. computeConfidence() already clamps,
    // but this guards against callers that bypass the pipeline.
    const contactConfidence = Math.max(0, Math.min(1, updates.contactConfidence));
    await this.backend.updateScoringFields(contactId, { ...updates, contactConfidence });
  }

  private computeGoldenRecord(
    primary: Contact,
    primaryIdentities: ChannelIdentity[],
    primaryOverrides: Array<{ permission: string; granted: boolean }>,
    secondary: Contact,
    secondaryIdentities: ChannelIdentity[],
    secondaryOverrides: Array<{ permission: string; granted: boolean }>,
  ): MergeGoldenRecord {
    const primaryIsMoreRecent = primary.updatedAt.getTime() >= secondary.updatedAt.getTime();

    const displayName = primaryIsMoreRecent
      ? (primary.displayName || secondary.displayName)
      : (secondary.displayName || primary.displayName);

    const role = primaryIsMoreRecent
      ? (primary.role ?? secondary.role)
      : (secondary.role ?? primary.role);

    // Both notes are preserved — neither is discarded
    const noteParts = [primary.notes, secondary.notes].filter(Boolean);
    const notes = noteParts.length > 0 ? noteParts.join('\n---\n') : null;

    // Tier survivorship. A structural primary (principal/agent/system-role) always keeps
    // its own tier — a merge must never downgrade it, not even via blocked-wins: merging
    // a 'blocked' duplicate into the principal must not lock the principal out. For
    // ordinary contacts, a 'blocked' tier on either side wins (most restrictive, so a
    // merge can never un-block a contact); otherwise the more-capable (higher TIER_RANK)
    // tier survives, preserving any explicit CEO grant (trusted/principal).
    const tier: ContactTier = isStructuralContact(primary)
      ? primary.tier
      : primary.tier === 'blocked' || secondary.tier === 'blocked'
        ? 'blocked'
        : TIER_RANK[primary.tier] >= TIER_RANK[secondary.tier]
          ? primary.tier
          : secondary.tier;

    // Union of identities — deduplicated by channel:channelIdentifier key
    const identityKeys = new Set<string>();
    const identities: ChannelIdentity[] = [];
    for (const identity of [...primaryIdentities, ...secondaryIdentities]) {
      const key = `${identity.channel}:${identity.channelIdentifier}`;
      if (!identityKeys.has(key)) {
        identityKeys.add(key);
        identities.push(identity);
      }
    }

    // Union of auth overrides — primary wins on same-permission conflict
    const overridePerms = new Set<string>(primaryOverrides.map(o => o.permission));
    const authOverrides = [...primaryOverrides];
    for (const override of secondaryOverrides) {
      if (!overridePerms.has(override.permission)) {
        authOverrides.push(override);
      }
    }

    return { displayName, role, notes, tier, identities, authOverrides };
  }
}

// -- Postgres-specific row shape (all 28 columns as of migration 055) --
// Shared across all queries that return a full Contact record.
// The 12 canonical fields (added in migration 048) and the 2 tier/kind fields
// (added in migration 055) are all null-safe — they default to sensible values
// when the column was added after the row was first written.
type ContactRow = {
  id: string;
  kg_node_id: string | null;
  display_name: string;
  role: string | null;
  system_role: string | null;
  // Capability axis (migration 055). The legacy status/trust_level columns still exist
  // in the DB (dropped later in migration 059) but are no longer read into the row shape.
  tier: string;
  kind: string;
  contact_confidence: string;
  last_seen_at: Date | null;
  inbound_message_count: string;
  outbound_message_count: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  // Canonical fields (migration 048)
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
};

// Column list for all SELECT queries that return a full Contact row.
// tier and kind added in migration 055.
const CONTACT_COLS =
  'id, kg_node_id, display_name, role, system_role, tier, kind, ' +
  'contact_confidence, last_seen_at, inbound_message_count, outbound_message_count, notes, ' +
  'created_at, updated_at, ' +
  'preferred_name, title, organization, primary_email, primary_phone, timezone, locale, location, ' +
  'pronouns, linkedin_url, bio, birthday';

// -- Postgres backend --

/**
 * Postgres-backed storage for contacts and channel identities.
 * Uses parameterized queries throughout — never interpolates user input into SQL.
 */
class PostgresContactBackend implements ContactServiceBackend {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  async createContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: creating contact');
    // tier and kind added in migration 055
    await this.pool.query(
      `INSERT INTO contacts (
         id, kg_node_id, display_name, role, system_role, tier, kind, notes, created_at, updated_at,
         preferred_name, title, organization, primary_email, primary_phone, timezone, locale,
         location, pronouns, linkedin_url, bio, birthday
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.systemRole,
        contact.tier, contact.kind, contact.notes, contact.createdAt, contact.updatedAt,
        contact.preferredName, contact.title, contact.organization, contact.primaryEmail,
        contact.primaryPhone, contact.timezone, contact.locale, contact.location,
        contact.pronouns, contact.linkedinUrl, contact.bio, contact.birthday,
      ],
    );
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return this.rowToContact(row);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    // Substring match (case-insensitive) so partial names like "Jo" match "Jo Brennan".
    // Uses ILIKE with wildcards — the idx_contacts_display_name btree index won't help here,
    // but the contacts table is small (hundreds, not millions) so a seq scan is fine.
    // For exact match, the caller can filter the results further.
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE display_name ILIKE $1`,
      [`%${name}%`],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async findContactByKgNodeId(kgNodeId: string): Promise<Contact | null> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE kg_node_id = $1 LIMIT 1`,
      [kgNodeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToContact(row);
  }

  async findContactByRole(role: string): Promise<Contact[]> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE role = $1 ORDER BY created_at ASC`,
      [role],
    );

    return result.rows.map((row) => this.rowToContact(row));
  }

  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE system_role = $1 LIMIT 1`,
      [systemRole],
    );

    const row = result.rows[0];
    if (!row) return null;
    return this.rowToContact(row);
  }

  async listContacts(filters?: { tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // tier filter (issue #945) — the single capability axis after the #955 cutover.
    if (filters?.tier != null) {
      params.push(filters.tier);
      conditions.push(`tier = $${params.length}`);
    }

    // kind filter: pass as a Postgres array and use = ANY($N) for inclusion.
    if (filters?.kind != null && filters.kind.length > 0) {
      params.push(filters.kind);
      conditions.push(`kind = ANY($${params.length})`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT ${CONTACT_COLS} FROM contacts${where} ORDER BY created_at ASC`;

    if (filters?.limit != null) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }

    // Skip OFFSET 0 — it is a no-op in Postgres and saves a parameter slot.
    // InMemory backend uses slice(offset, end) which also handles 0 correctly.
    if (filters?.offset != null && filters.offset > 0) {
      params.push(filters.offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await this.pool.query<ContactRow>(sql, params);

    return result.rows.map((row) => this.rowToContact(row));
  }

  async updateContact(contact: Contact, client?: DbPoolClient): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: updating contact');
    // system_role is included so bootstrap and any future setter can persist it through the standard update path.
    // tier and kind (migration 055) are included so setTier keeps them in sync.
    // contact_confidence and last_seen_at remain scoring-owned and are not updated here.
    const queryFn = client ?? this.pool;
    await queryFn.query(
      `UPDATE contacts SET
         kg_node_id = $2, display_name = $3, role = $4, system_role = $5,
         notes = $6, tier = $7, kind = $8, updated_at = $9,
         preferred_name = $10, title = $11, organization = $12, primary_email = $13,
         primary_phone = $14, timezone = $15, locale = $16, location = $17,
         pronouns = $18, linkedin_url = $19, bio = $20, birthday = $21
       WHERE id = $1`,
      [
        contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.systemRole,
        contact.notes, contact.tier, contact.kind, contact.updatedAt,
        contact.preferredName, contact.title, contact.organization, contact.primaryEmail,
        contact.primaryPhone, contact.timezone, contact.locale, contact.location,
        contact.pronouns, contact.linkedinUrl, contact.bio, contact.birthday,
      ],
    );
  }

  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    this.logger.debug({ contactId }, 'contacts: updating scoring fields');
    await this.pool.query(
      `UPDATE contacts
       SET contact_confidence = $2,
           inbound_message_count = inbound_message_count + $3,
           outbound_message_count = outbound_message_count + $4,
           last_seen_at = COALESCE($5, last_seen_at),
           updated_at = now()
       WHERE id = $1`,
      [
        contactId,
        updates.contactConfidence,
        updates.inboundMessageCountDelta ?? 0,
        updates.outboundMessageCountDelta ?? 0,
        updates.lastSeenAt ?? null,
      ],
    );
  }

  async createIdentity(identity: ChannelIdentity): Promise<void> {
    this.logger.debug(
      { identityId: identity.id, contactId: identity.contactId, channel: identity.channel },
      'contacts: creating channel identity',
    );
    await this.pool.query(
      `INSERT INTO contact_channel_identities
         (id, contact_id, channel, channel_identifier, label, verified, verified_at, source, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        identity.id,
        identity.contactId,
        identity.channel,
        identity.channelIdentifier,
        identity.label,
        identity.verified,
        identity.verifiedAt,
        identity.source,
        identity.status,
        identity.createdAt,
        identity.updatedAt,
      ],
    );
  }

  async getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]> {
    const result = await this.pool.query<{
      id: string;
      contact_id: string;
      channel: string;
      channel_identifier: string;
      label: string | null;
      verified: boolean;
      verified_at: Date | null;
      status: string;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, contact_id, channel, channel_identifier, label, verified, verified_at, status, source, created_at, updated_at
       FROM contact_channel_identities WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );

    return result.rows.map((row) => this.rowToIdentity(row));
  }

  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    // Normalize email lookups to lowercase so mixed-case entries (stored before
    // write-time normalization was added) are still matched.
    const normalizedId = channel === 'email'
      ? channelIdentifier.toLowerCase()
      : channelIdentifier;

    const result = await this.pool.query<{
      id: string;
      display_name: string;
      role: string | null;
      system_role: string | null;
      tier: string;
      kind: string;
      kg_node_id: string | null;
      verified: boolean;
      contact_confidence: string;  // NUMERIC returned as string by node-pg
    }>(
      `SELECT c.id, c.display_name, c.role, c.system_role,
              c.tier, c.kind, c.kg_node_id, cci.verified, c.contact_confidence
       FROM contact_channel_identities cci
       JOIN contacts c ON c.id = cci.contact_id
       WHERE cci.channel = $1
         AND CASE WHEN $1 = 'email' THEN LOWER(cci.channel_identifier) = $2
                  ELSE cci.channel_identifier = $2 END`,
      [channel, normalizedId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      contactId: row.id,
      displayName: row.display_name,
      role: row.role,
      // Validate system_role — DB CHECK constraint normally prevents invalid values, but
      // guard defensively the same way we guard tier below.
      systemRole: (row.system_role === 'principal' || row.system_role === 'agent') ? row.system_role : null,
      kgNodeId: row.kg_node_id,
      verified: row.verified,
      // PostgreSQL returns NUMERIC as a string via node-pg.
      // Guard against NaN — if migration 020 hasn't run, the column is absent and
      // parseFloat(undefined) = NaN, which would silently corrupt trust score computation.
      contactConfidence: (() => {
        const v = parseFloat(row.contact_confidence);
        return isFinite(v) ? v : 0.0;
      })(),
      // Validate tier against the allowed enum — fail-closed on corrupt DB values.
      // null/undefined (column absent pre-migration) → 'unknown' (benign, conservative).
      // A PRESENT but unrecognized value is a data integrity problem: log at ERROR and
      // return 'blocked' so a corrupted 'blocked' row cannot be un-blocked by bad data.
      tier: (() => {
        if (row.tier == null) return 'unknown' as ContactTier;
        if ((Object.keys(TIER_RANK) as ContactTier[]).includes(row.tier as ContactTier)) {
          return row.tier as ContactTier;
        }
        this.logger.error(
          { contactId: row.id, rawTier: row.tier },
          'contacts: unrecognized tier value in DB — failing closed to blocked',
        );
        return 'blocked' as ContactTier;
      })(),
      kind: (() => {
        if (row.kind == null) return 'person' as ContactKind;
        if ((['person', 'organization', 'automated', 'principal', 'agent'] as ContactKind[]).includes(row.kind as ContactKind)) {
          return row.kind as ContactKind;
        }
        this.logger.error(
          { contactId: row.id, rawKind: row.kind },
          'contacts: unrecognized kind value in DB',
        );
        return 'person' as ContactKind;
      })(),
    };
  }

  async unlinkIdentity(identityId: string): Promise<boolean> {
    this.logger.debug({ identityId }, 'Unlinking channel identity');
    const result = await this.pool.query('DELETE FROM contact_channel_identities WHERE id = $1', [identityId]);
    return (result.rowCount ?? 0) > 0;
  }


  async elevateTierToKnown(contactId: string, _reason: string): Promise<boolean> {
    // Atomic conditional: only upgrades tier when it is STILL 'unknown' at write time
    // AND the contact's kind is not automated or agent.
    // The reason parameter is accepted for interface compatibility but not written to the
    // DB here — it is logged at the service layer for the audit trail.
    const result = await this.pool.query(
      `UPDATE contacts
       SET tier = 'known', updated_at = now()
       WHERE id = $1
         AND COALESCE(tier, 'unknown') = 'unknown'
         AND COALESCE(kind, 'person') NOT IN ('automated', 'agent')`,
      [contactId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    this.logger.debug({ identityId, status }, 'contacts: updating identity status');
    const result = await this.pool.query<{
      id: string;
      contact_id: string;
      channel: string;
      channel_identifier: string;
      label: string | null;
      verified: boolean;
      verified_at: Date | null;
      status: string;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE contact_channel_identities
       SET status = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, contact_id, channel, channel_identifier, label, verified, verified_at, status, source, created_at, updated_at`,
      [status, identityId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new IdentityNotFoundError(identityId);
    }
    return this.rowToIdentity(row);
  }

  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    const result = await this.pool.query<{
      permission: string;
      granted: boolean;
    }>(
      `SELECT permission, granted FROM contact_auth_overrides
       WHERE contact_id = $1 AND revoked_at IS NULL`,
      [contactId],
    );

    return result.rows.map((row) => ({
      permission: row.permission,
      granted: row.granted,
    }));
  }

  async createAuthOverride(override: AuthOverride): Promise<void> {
    this.logger.debug(
      { contactId: override.contactId, permission: override.permission, granted: override.granted },
      'contacts: creating auth override',
    );
    // Upsert: if an active override exists for this contact+permission, update it.
    // The UNIQUE(contact_id, permission) constraint on the table supports this.
    await this.pool.query(
      `INSERT INTO contact_auth_overrides (id, contact_id, permission, granted, granted_by, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (contact_id, permission) DO UPDATE
         SET granted = EXCLUDED.granted,
             granted_by = EXCLUDED.granted_by,
             created_at = EXCLUDED.created_at,
             revoked_at = NULL`,
      [override.id, override.contactId, override.permission, override.granted, override.grantedBy, override.createdAt, override.revokedAt],
    );
  }

  async revokeAuthOverride(contactId: string, permission: string): Promise<boolean> {
    this.logger.debug({ contactId, permission }, 'Revoking auth override');
    const result = await this.pool.query(
      `UPDATE contact_auth_overrides SET revoked_at = now()
       WHERE contact_id = $1 AND permission = $2 AND revoked_at IS NULL`,
      [contactId, permission],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ---- Grant recommendations (issue #952) ----

  async createGrantRecommendation(rec: GrantRecommendation): Promise<void> {
    await this.pool.query(
      `INSERT INTO grant_recommendations
         (id, contact_id, permission, reasoning, status, suggested_at, resolved_at, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (contact_id, permission) DO NOTHING`,
      [rec.id, rec.contactId, rec.permission, rec.reasoning, rec.status, rec.suggestedAt, rec.resolvedAt, rec.resolvedBy],
    );
  }

  async getGrantRecommendation(id: string): Promise<GrantRecommendation | null> {
    const result = await this.pool.query<{
      id: string; contact_id: string; permission: string; reasoning: string;
      status: string; suggested_at: Date; resolved_at: Date | null; resolved_by: string | null;
    }>(
      `SELECT id, contact_id, permission, reasoning, status, suggested_at, resolved_at, resolved_by
       FROM grant_recommendations WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToGrantRecommendation(row);
  }

  async findGrantRecommendation(contactId: string, permission: string): Promise<GrantRecommendation | null> {
    const result = await this.pool.query<{
      id: string; contact_id: string; permission: string; reasoning: string;
      status: string; suggested_at: Date; resolved_at: Date | null; resolved_by: string | null;
    }>(
      `SELECT id, contact_id, permission, reasoning, status, suggested_at, resolved_at, resolved_by
       FROM grant_recommendations WHERE contact_id = $1 AND permission = $2`,
      [contactId, permission],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToGrantRecommendation(row);
  }

  async listGrantRecommendations(
    filters?: { status?: GrantRecommendationStatus; limit?: number },
  ): Promise<GrantRecommendation[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    if (filters?.limit) {
      params.push(filters.limit);
    }
    const limitClause = filters?.limit ? `LIMIT $${params.length}` : '';

    const result = await this.pool.query<{
      id: string; contact_id: string; permission: string; reasoning: string;
      status: string; suggested_at: Date; resolved_at: Date | null; resolved_by: string | null;
    }>(
      `SELECT id, contact_id, permission, reasoning, status, suggested_at, resolved_at, resolved_by
       FROM grant_recommendations ${where} ORDER BY suggested_at DESC ${limitClause}`,
      params,
    );
    return result.rows.map(row => this.rowToGrantRecommendation(row));
  }

  async resolveGrantRecommendation(id: string, status: 'approved' | 'declined', resolvedBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE grant_recommendations
       SET status = $2, resolved_at = now(), resolved_by = $3
       WHERE id = $1 AND status = 'pending'`,
      [id, status, resolvedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private rowToGrantRecommendation(row: {
    id: string; contact_id: string; permission: string; reasoning: string;
    status: string; suggested_at: Date; resolved_at: Date | null; resolved_by: string | null;
  }): GrantRecommendation {
    return {
      id: row.id,
      contactId: row.contact_id,
      permission: row.permission,
      reasoning: row.reasoning,
      status: row.status as GrantRecommendationStatus,
      suggestedAt: row.suggested_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
    };
  }

  async createCalendarLink(calendar: ContactCalendar): Promise<void> {
    this.logger.debug({ calendarId: calendar.id, nylasCalendarId: calendar.nylasCalendarId }, 'contacts: linking calendar');
    await this.pool.query(
      `INSERT INTO contact_calendars (id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [calendar.id, calendar.nylasCalendarId, calendar.contactId, calendar.label, calendar.isPrimary, calendar.readOnly, calendar.timezone, calendar.createdAt, calendar.updatedAt],
    );
  }

  async deleteCalendarLink(nylasCalendarId: string): Promise<boolean> {
    this.logger.debug({ nylasCalendarId }, 'contacts: unlinking calendar');
    const result = await this.pool.query(
      'DELETE FROM contact_calendars WHERE nylas_calendar_id = $1',
      [nylasCalendarId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    const result = await this.pool.query<{
      id: string;
      nylas_calendar_id: string;
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at
       FROM contact_calendars WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );
    return result.rows.map((row) => this.rowToCalendar(row));
  }

  async resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null> {
    const result = await this.pool.query<{
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
    }>(
      `SELECT contact_id, label, is_primary, read_only
       FROM contact_calendars WHERE nylas_calendar_id = $1`,
      [nylasCalendarId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contactId: row.contact_id,
      label: row.label,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
    };
  }

  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    const result = await this.pool.query<{
      id: string;
      nylas_calendar_id: string;
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at
       FROM contact_calendars WHERE contact_id = $1 AND is_primary = true`,
      [contactId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToCalendar(row);
  }

  async reattachIdentities(fromContactId: string, toContactId: string): Promise<void> {
    // Delete identities that would conflict with the primary's existing ones
    await this.pool.query(
      `DELETE FROM contact_channel_identities
       WHERE contact_id = $1
         AND (channel, channel_identifier) IN (
           SELECT channel, channel_identifier
           FROM contact_channel_identities
           WHERE contact_id = $2
         )`,
      [fromContactId, toContactId],
    );
    await this.pool.query(
      `UPDATE contact_channel_identities SET contact_id = $1 WHERE contact_id = $2`,
      [toContactId, fromContactId],
    );
  }

  async reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM contact_auth_overrides
       WHERE contact_id = $1
         AND revoked_at IS NULL
         AND permission IN (
           SELECT permission FROM contact_auth_overrides
           WHERE contact_id = $2 AND revoked_at IS NULL
         )`,
      [fromContactId, toContactId],
    );
    // Only re-point active (non-revoked) rows; revoked rows stay on the secondary
    // and will be effectively deleted when the secondary contact is deleted.
    await this.pool.query(
      `UPDATE contact_auth_overrides SET contact_id = $1 WHERE contact_id = $2 AND revoked_at IS NULL`,
      [toContactId, fromContactId],
    );
  }

  async deleteContact(id: string): Promise<void> {
    this.logger.debug({ contactId: id }, 'contacts: deleting contact');
    await this.pool.query(`DELETE FROM contacts WHERE id = $1`, [id]);
  }

  // -- Row mapping helpers --

  private rowToContact(row: ContactRow): Contact {
    return {
      id: row.id,
      kgNodeId: row.kg_node_id,
      displayName: row.display_name,
      role: row.role,
      systemRole: (row.system_role === 'principal' || row.system_role === 'agent' || row.system_role === 'system')
        ? row.system_role
        : null,
      // Capability axis (migration 055). Fail-closed on corrupt DB values:
      // null/undefined (column absent pre-migration) → safe default.
      // A PRESENT but unrecognized tier is a data integrity problem — log at ERROR
      // and return 'blocked' so a corrupted 'blocked' row cannot be un-blocked by
      // bad data. For kind (not a security gate), log at ERROR but keep 'person'.
      tier: (() => {
        if (row.tier == null) return 'unknown' as ContactTier;
        if ((Object.keys(TIER_RANK) as ContactTier[]).includes(row.tier as ContactTier)) {
          return row.tier as ContactTier;
        }
        this.logger.error(
          { contactId: row.id, rawTier: row.tier },
          'contacts: unrecognized tier value in DB — failing closed to blocked',
        );
        return 'blocked' as ContactTier;
      })(),
      kind: (() => {
        if (row.kind == null) return 'person' as ContactKind;
        if ((['person', 'organization', 'automated', 'principal', 'agent'] as ContactKind[]).includes(row.kind as ContactKind)) {
          return row.kind as ContactKind;
        }
        this.logger.error(
          { contactId: row.id, rawKind: row.kind },
          'contacts: unrecognized kind value in DB',
        );
        return 'person' as ContactKind;
      })(),
      // PostgreSQL returns NUMERIC as a string via node-pg.
      // Guard against NaN — if migration 020 hasn't run, the column is absent and
      // parseFloat(undefined) = NaN, which would silently corrupt trust score computation.
      contactConfidence: (() => {
        const v = parseFloat(row.contact_confidence);
        return isFinite(v) ? v : 0.0;
      })(),
      lastSeenAt: row.last_seen_at,
      inboundMessageCount: parseInt(row.inbound_message_count, 10) || 0,
      outboundMessageCount: parseInt(row.outbound_message_count, 10) || 0,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Canonical fields (migration 048)
      preferredName: row.preferred_name,
      title: row.title,
      organization: row.organization,
      primaryEmail: row.primary_email,
      primaryPhone: row.primary_phone,
      timezone: row.timezone,
      locale: row.locale,
      location: row.location,
      pronouns: row.pronouns,
      linkedinUrl: row.linkedin_url,
      bio: row.bio,
      birthday: row.birthday,
    };
  }

  private rowToIdentity(row: {
    id: string;
    contact_id: string;
    channel: string;
    channel_identifier: string;
    label: string | null;
    verified: boolean;
    verified_at: Date | null;
    status: string;
    source: string;
    created_at: Date;
    updated_at: Date;
  }): ChannelIdentity {
    return {
      id: row.id,
      contactId: row.contact_id,
      channel: row.channel,
      channelIdentifier: row.channel_identifier,
      label: row.label,
      verified: row.verified,
      verifiedAt: row.verified_at,
      status: row.status as IdentityStatus,
      source: row.source as IdentitySource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToCalendar(row: {
    id: string;
    nylas_calendar_id: string;
    contact_id: string | null;
    label: string;
    is_primary: boolean;
    read_only: boolean;
    timezone: string | null;
    created_at: Date;
    updated_at: Date;
  }): ContactCalendar {
    return {
      id: row.id,
      nylasCalendarId: row.nylas_calendar_id,
      contactId: row.contact_id,
      label: row.label,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
      timezone: row.timezone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// -- In-memory backend --

/**
 * In-memory storage for testing. No database required.
 * Uses Maps for contacts and identities, with array scans for search operations.
 */
class InMemoryContactBackend implements ContactServiceBackend {
  private contacts = new Map<string, Contact>();
  private identities = new Map<string, ChannelIdentity>();
  private overrides = new Map<string, AuthOverride>();
  private calendars = new Map<string, ContactCalendar>();

  async createContact(contact: Contact): Promise<void> {
    // Enforce the partial unique index idx_contacts_kg_node_unique to match Postgres.
    if (contact.kgNodeId !== null) {
      for (const existing of this.contacts.values()) {
        if (existing.kgNodeId === contact.kgNodeId) {
          const err = Object.assign(new Error('duplicate key value violates unique constraint "idx_contacts_kg_node_unique"'), {
            code: '23505',
            constraint: 'idx_contacts_kg_node_unique',
          });
          throw err;
        }
      }
    }
    // Enforce system_role uniqueness to match Postgres partial unique indexes
    if (contact.systemRole) {
      for (const existing of this.contacts.values()) {
        if (existing.systemRole === contact.systemRole) {
          const err = Object.assign(
            new Error(`duplicate key value violates unique constraint "idx_contacts_system_role_${contact.systemRole}"`),
            { code: '23505', constraint: `idx_contacts_system_role_${contact.systemRole}` },
          );
          throw err;
        }
      }
    }
    this.contacts.set(contact.id, contact);
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async findContactByName(name: string): Promise<Contact[]> {
    // Substring match (case-insensitive) to match the Postgres ILIKE behavior
    const lowerName = name.toLowerCase();
    const results: Contact[] = [];
    for (const contact of this.contacts.values()) {
      if (contact.displayName.toLowerCase().includes(lowerName)) {
        results.push(contact);
      }
    }
    return results;
  }

  async findContactByKgNodeId(kgNodeId: string): Promise<Contact | null> {
    for (const contact of this.contacts.values()) {
      if (contact.kgNodeId === kgNodeId) return contact;
    }
    return null;
  }

  async findContactByRole(role: string): Promise<Contact[]> {
    const results: Contact[] = [];
    for (const contact of this.contacts.values()) {
      if (contact.role === role) {
        results.push(contact);
      }
    }
    return results;
  }

  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    for (const contact of this.contacts.values()) {
      if (contact.systemRole === systemRole) return contact;
    }
    return null;
  }

  async listContacts(filters?: { tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]> {
    let results = [...this.contacts.values()];

    // tier filter (issue #945) — the single capability axis after the #955 cutover
    if (filters?.tier != null) {
      results = results.filter((c) => c.tier === filters.tier);
    }

    // kind filter: include only contacts whose kind appears in the provided array
    if (filters?.kind != null && filters.kind.length > 0) {
      results = results.filter((c) => filters.kind!.includes(c.kind));
    }

    // Sort by createdAt ascending to match Postgres ORDER BY created_at ASC
    results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Mirror the Postgres path: only apply offset when > 0 so negative values
    // (which the handler rejects, but the backend should also handle safely)
    // never produce Array.slice(negative) semantics that differ from Postgres.
    const offset = filters?.offset != null && filters.offset > 0 ? filters.offset : 0;
    const end = filters?.limit != null ? offset + filters.limit : undefined;
    results = results.slice(offset, end);

    return results;
  }

  async updateContact(contact: Contact, _client?: DbPoolClient): Promise<void> {
    // Enforce system_role uniqueness on update, to match Postgres partial unique indexes.
    // Exclude the contact being updated from the duplicate check.
    if (contact.systemRole) {
      for (const [existingId, existing] of this.contacts.entries()) {
        if (existingId !== contact.id && existing.systemRole === contact.systemRole) {
          const err = Object.assign(
            new Error(`duplicate key value violates unique constraint "idx_contacts_system_role_${contact.systemRole}"`),
            { code: '23505', constraint: `idx_contacts_system_role_${contact.systemRole}` },
          );
          throw err;
        }
      }
    }
    this.contacts.set(contact.id, contact);
  }

  async updateScoringFields(
    contactId: string,
    updates: {
      inboundMessageCountDelta?: number;
      outboundMessageCountDelta?: number;
      contactConfidence: number;
      lastSeenAt?: Date;
    },
  ): Promise<void> {
    const contact = this.contacts.get(contactId);
    if (!contact) return;
    this.contacts.set(contactId, {
      ...contact,
      contactConfidence: updates.contactConfidence,
      inboundMessageCount: contact.inboundMessageCount + (updates.inboundMessageCountDelta ?? 0),
      outboundMessageCount: contact.outboundMessageCount + (updates.outboundMessageCountDelta ?? 0),
      lastSeenAt: updates.lastSeenAt ?? contact.lastSeenAt,
      updatedAt: new Date(),
    });
  }

  async elevateTierToKnown(contactId: string, _reason: string): Promise<boolean> {
    // JS is single-threaded, so check-and-set is effectively atomic here.
    // Mirrors the conditional logic of the Postgres implementation.
    const contact = this.contacts.get(contactId);
    if (!contact || contact.tier !== 'unknown') return false;
    if (contact.kind === 'automated' || contact.kind === 'agent') return false;
    this.contacts.set(contactId, { ...contact, tier: 'known', updatedAt: new Date() });
    return true;
  }

  async createIdentity(identity: ChannelIdentity): Promise<void> {
    // Enforce UNIQUE(channel, channel_identifier) to match Postgres behavior.
    // Without this, the in-memory backend would silently allow duplicates
    // that Postgres would reject via its unique index.
    for (const existing of this.identities.values()) {
      if (existing.channel === identity.channel && existing.channelIdentifier === identity.channelIdentifier) {
        // Throw with the same shape as Postgres unique-violation errors (code 23505)
        // so callers can detect duplicates uniformly across backends.
        throw Object.assign(
          new Error(`duplicate key value violates unique constraint "contact_channel_identities_channel_channel_identifier_key"`),
          { code: '23505', constraint: 'contact_channel_identities_channel_channel_identifier_key' },
        );
      }
    }
    this.identities.set(identity.id, identity);
  }

  async getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]> {
    const results: ChannelIdentity[] = [];
    for (const identity of this.identities.values()) {
      if (identity.contactId === contactId) {
        results.push(identity);
      }
    }
    return results;
  }

  async resolveByChannelIdentity(
    channel: string,
    channelIdentifier: string,
  ): Promise<ResolvedSender | null> {
    // Normalize email lookups to lowercase (mirrors Postgres backend).
    const normalizedId = channel === 'email'
      ? channelIdentifier.toLowerCase()
      : channelIdentifier;

    // Find the matching identity, then look up the contact
    for (const identity of this.identities.values()) {
      const storedId = channel === 'email'
        ? identity.channelIdentifier.toLowerCase()
        : identity.channelIdentifier;
      if (identity.channel === channel && storedId === normalizedId) {
        const contact = this.contacts.get(identity.contactId);
        if (contact) {
          return {
            contactId: contact.id,
            displayName: contact.displayName,
            role: contact.role,
            systemRole: contact.systemRole,
            tier: contact.tier,
            kind: contact.kind,
            kgNodeId: contact.kgNodeId,
            verified: identity.verified,
            contactConfidence: contact.contactConfidence ?? 0,
          };
        }
      }
    }
    return null;
  }

  async unlinkIdentity(identityId: string): Promise<boolean> {
    return this.identities.delete(identityId);
  }

  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    const identity = this.identities.get(identityId);
    if (!identity) {
      throw new IdentityNotFoundError(identityId);
    }
    const updated: ChannelIdentity = {
      ...identity,
      status,
      updatedAt: new Date(),
    };
    this.identities.set(identityId, updated);
    return updated;
  }

  async getAuthOverrides(contactId: string): Promise<Array<{ permission: string; granted: boolean }>> {
    const results: Array<{ permission: string; granted: boolean }> = [];
    for (const override of this.overrides.values()) {
      if (override.contactId === contactId && override.revokedAt === null) {
        results.push({ permission: override.permission, granted: override.granted });
      }
    }
    return results;
  }

  async createAuthOverride(override: AuthOverride): Promise<void> {
    // Upsert: find and replace any existing active override for the same contact+permission
    for (const [key, existing] of this.overrides.entries()) {
      if (
        existing.contactId === override.contactId &&
        existing.permission === override.permission &&
        existing.revokedAt === null
      ) {
        this.overrides.delete(key);
        break;
      }
    }
    this.overrides.set(override.id, override);
  }

  async revokeAuthOverride(contactId: string, permission: string): Promise<boolean> {
    for (const [id, override] of this.overrides) {
      if (override.contactId === contactId &&
          override.permission === permission &&
          override.revokedAt === null) {
        this.overrides.set(id, { ...override, revokedAt: new Date() });
        return true;
      }
    }
    return false;
  }

  async createCalendarLink(calendar: ContactCalendar): Promise<void> {
    // Enforce UNIQUE(nylas_calendar_id)
    for (const existing of this.calendars.values()) {
      if (existing.nylasCalendarId === calendar.nylasCalendarId) {
        throw new Error(`Calendar already registered: ${calendar.nylasCalendarId}`);
      }
    }
    // Enforce at-most-one-primary per contact
    if (calendar.isPrimary && calendar.contactId !== null) {
      for (const existing of this.calendars.values()) {
        if (existing.contactId === calendar.contactId && existing.isPrimary) {
          throw new Error(`Contact ${calendar.contactId} already has a primary calendar`);
        }
      }
    }
    this.calendars.set(calendar.id, calendar);
  }

  async deleteCalendarLink(nylasCalendarId: string): Promise<boolean> {
    for (const [id, cal] of this.calendars) {
      if (cal.nylasCalendarId === nylasCalendarId) {
        this.calendars.delete(id);
        return true;
      }
    }
    return false;
  }

  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    const results: ContactCalendar[] = [];
    for (const cal of this.calendars.values()) {
      if (cal.contactId === contactId) {
        results.push(cal);
      }
    }
    return results;
  }

  async resolveCalendar(nylasCalendarId: string): Promise<ResolvedCalendar | null> {
    for (const cal of this.calendars.values()) {
      if (cal.nylasCalendarId === nylasCalendarId) {
        return {
          contactId: cal.contactId,
          label: cal.label,
          isPrimary: cal.isPrimary,
          readOnly: cal.readOnly,
        };
      }
    }
    return null;
  }

  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    for (const cal of this.calendars.values()) {
      if (cal.contactId === contactId && cal.isPrimary) {
        return cal;
      }
    }
    return null;
  }

  async reattachIdentities(fromContactId: string, toContactId: string): Promise<void> {
    // Build set of channel:channelIdentifier keys already owned by the primary
    const primaryKeys = new Set<string>();
    for (const identity of this.identities.values()) {
      if (identity.contactId === toContactId) {
        primaryKeys.add(`${identity.channel}:${identity.channelIdentifier}`);
      }
    }
    // Re-point secondary's identities onto primary, discarding any that conflict
    for (const [id, identity] of this.identities) {
      if (identity.contactId !== fromContactId) continue;
      const key = `${identity.channel}:${identity.channelIdentifier}`;
      if (primaryKeys.has(key)) {
        // Duplicate — would violate UNIQUE constraint in Postgres, so discard
        this.identities.delete(id);
      } else {
        this.identities.set(id, { ...identity, contactId: toContactId });
        primaryKeys.add(key);
      }
    }
  }

  async reattachAuthOverrides(fromContactId: string, toContactId: string): Promise<void> {
    // Build set of permissions already held (active) by the primary
    const primaryPerms = new Set<string>();
    for (const override of this.overrides.values()) {
      if (override.contactId === toContactId && !override.revokedAt) {
        primaryPerms.add(override.permission);
      }
    }
    // Re-point secondary's active overrides; discard if primary already has one for same permission
    for (const [id, override] of this.overrides) {
      if (override.contactId !== fromContactId || override.revokedAt) continue;
      if (primaryPerms.has(override.permission)) {
        this.overrides.delete(id);
      } else {
        this.overrides.set(id, { ...override, contactId: toContactId });
        primaryPerms.add(override.permission);
      }
    }
  }

  async deleteContact(id: string): Promise<void> {
    this.contacts.delete(id);
    // Cascade-delete related rows, matching Postgres ON DELETE CASCADE behavior.
    // Without this, deleted contacts leave dangling identities/overrides in the in-memory
    // store that can bleed into subsequent tests.
    for (const [iid, identity] of this.identities) {
      if (identity.contactId === id) this.identities.delete(iid);
    }
    for (const [oid, override] of this.overrides) {
      if (override.contactId === id) this.overrides.delete(oid);
    }
    for (const [rk, rec] of this.recommendations) {
      if (rec.contactId === id) this.recommendations.delete(rk);
    }
  }

  // ---- Grant recommendations (issue #952) — in-memory stubs ----

  private recommendations = new Map<string, GrantRecommendation>();

  async createGrantRecommendation(rec: GrantRecommendation): Promise<void> {
    // Mimic Postgres FK constraint: contact must exist
    if (!this.contacts.has(rec.contactId)) {
      throw new Error(`Foreign key violation: contact '${rec.contactId}' does not exist`);
    }
    const key = `${rec.contactId}:${rec.permission}`;
    // Mimic ON CONFLICT DO NOTHING
    for (const r of this.recommendations.values()) {
      if (r.contactId === rec.contactId && r.permission === rec.permission) return;
    }
    this.recommendations.set(key, rec);
  }

  async getGrantRecommendation(id: string): Promise<GrantRecommendation | null> {
    for (const rec of this.recommendations.values()) {
      if (rec.id === id) return rec;
    }
    return null;
  }

  async findGrantRecommendation(contactId: string, permission: string): Promise<GrantRecommendation | null> {
    for (const rec of this.recommendations.values()) {
      if (rec.contactId === contactId && rec.permission === permission) return rec;
    }
    return null;
  }

  async listGrantRecommendations(
    filters?: { status?: GrantRecommendationStatus; limit?: number },
  ): Promise<GrantRecommendation[]> {
    let results = Array.from(this.recommendations.values());
    if (filters?.status) results = results.filter(r => r.status === filters.status);
    results.sort((a, b) => b.suggestedAt.getTime() - a.suggestedAt.getTime());
    if (filters?.limit) results = results.slice(0, filters.limit);
    return results;
  }

  async resolveGrantRecommendation(id: string, status: 'approved' | 'declined', resolvedBy: string): Promise<boolean> {
    for (const [key, rec] of this.recommendations) {
      if (rec.id === id && rec.status === 'pending') {
        this.recommendations.set(key, { ...rec, status, resolvedAt: new Date(), resolvedBy });
        return true;
      }
    }
    return false;
  }
}
