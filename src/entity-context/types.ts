// src/entity-context/types.ts
//
// EntityContext payload — the single structured object the entity-context
// system hands to skills and agents. Assembles KG facts, connected accounts,
// contact record, and first-degree relationships into one place.
//
// Design: context is a hint, not a gate. Missing fields mean the LLM should
// reason about how to proceed (e.g., search elsewhere), not hard-fail.

/**
 * Full context payload for a single entity (person, org, event, etc.).
 * Assembled from the KG, contacts table, and connected-accounts tables.
 */
export interface EntityContext {
  /** The KG node ID for this entity */
  entityId: string;

  /** KG node type: 'person', 'organization', 'event', etc. */
  entityType: string;

  /** Human-readable label from the KG node */
  label: string;

  /** Contact record — only populated for person entities that have a contact record */
  contact: {
    contactId: string;
    displayName: string;
    role: string | null;
  } | null;

  /** Known facts from the KG, grouped by category.
   *  Facts include confidence and freshness metadata so the consumer
   *  can weigh how much to trust them. */
  facts: EntityFact[];

  /** Connected accounts: calendars, email accounts, integrations.
   *  Structured resources with service-level identifiers. */
  connectedAccounts: ConnectedAccount[];

  /** First-degree KG relationships — useful for understanding context:
   *  "Jenna works at Acme", "Dreamforce is hosted by Salesforce", etc. */
  relationships: EntityRelationship[];
}

/**
 * A single fact stored in the KG about an entity.
 * Facts are KG nodes of type 'fact' linked to the entity via 'relates_to' edges.
 */
export interface EntityFact {
  /** Fact label, e.g. "timezone", "Aeroplan number", "scheduling preference" */
  label: string;
  /** Fact value — whatever the agent stored in the fact node's properties.value */
  value: unknown;
  /** Category for grouping — convention-driven, not an enum.
   *  Common values: 'preference', 'identifier', 'location', 'biographical',
   *  'scheduling', 'faith', 'travel', 'financial'. */
  category: string;
  /** Confidence score (0–1) from the KG temporal metadata */
  confidence: number;
  /** ISO string: when this fact was last confirmed */
  lastConfirmedAt: string;
}

/**
 * A connected account linking an entity to an external service.
 * Today: contact_calendars. Future: contact_email_accounts, contact_integrations.
 */
export interface ConnectedAccount {
  /** Account type: 'calendar', 'email', 'crm', etc. */
  type: string;
  /** Human-readable label, e.g. "Work calendar", "Personal Gmail" */
  label: string;
  /** Service-specific identifier (Nylas calendar ID, email address, etc.) */
  serviceId: string;
  /** Whether this is the primary account of its type for this entity */
  isPrimary: boolean;
  /** Whether the account is read-only */
  readOnly: boolean;
  /** Additional metadata: timezone for calendars, signatures for email, etc. */
  metadata: Record<string, unknown>;
}

/**
 * A first-degree KG relationship between the entity and another KG node.
 */
export interface EntityRelationship {
  /** Edge type: 'works_on', 'relates_to', 'attended', etc. */
  type: string;
  /** Direction relative to this entity: outbound = this → target; inbound = source → this */
  direction: 'outbound' | 'inbound';
  /** The related entity's KG node ID */
  relatedEntityId: string;
  /** The related entity's human-readable label */
  relatedEntityLabel: string;
  /** The related entity's KG node type */
  relatedEntityType: string;
}
