// Shared harness for contact-resolution integration tests (#1382).
// Parallel-safe: tracks created IDs and deletes by id (never blanket DELETE).
// Self-skips when DATABASE_URL is unset.

import path from 'node:path';
import { describe } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import { loadAuthConfig } from '../../../src/contacts/config-loader.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createLogger, createSilentLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';

const { Pool } = pg;

export const DATABASE_URL = process.env['DATABASE_URL'];
export const describeIf = DATABASE_URL ? describe : describe.skip;
export const CONFIG_DIR = path.join(process.cwd(), 'config');

export function makeRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Deterministic digit-only Signal identifier derived from runId.
 * `salt` differentiates multiple identities within the same suite.
 */
export function signalForRun(runId: string, salt = 0): string {
  let n = salt >>> 0;
  for (let i = 0; i < runId.length; i++) {
    n = (n * 31 + runId.charCodeAt(i)) >>> 0;
  }
  // Keep NPA in the 7xx range so callers can vary the area code by salt.
  const npa = 700 + (salt % 100);
  return `+1${npa}${String(n % 10_000_000).padStart(7, '0')}`;
}

export interface ContactTestStack {
  pool: pg.Pool;
  logger: Logger;
  entityMemory: EntityMemory;
  contactService: ContactService;
  authService: AuthorizationService;
  resolver: ContactResolver;
  createdContactIds: string[];
  createdKgNodeIds: string[];
  trackContact: (contactId: string, kgNodeId?: string | null) => void;
  /** Track arbitrary KG nodes (e.g. fact nodes from storeFact) for teardown. */
  trackKgNode: (kgNodeId: string) => void;
  cleanup: () => Promise<void>;
}

/**
 * Wire ContactService + ContactResolver + AuthorizationService against real Postgres.
 * Same service stack as tests/integration/contacts.test.ts, with auth wired in
 * and parallel-safe ID-scoped cleanup (dedup-contacts-merge.test.ts pattern).
 */
export async function createContactStack(): Promise<ContactTestStack> {
  if (!DATABASE_URL) {
    throw new Error('createContactStack requires DATABASE_URL');
  }

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const logger = createLogger('error');
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    const entityMemory = new EntityMemory(kgStore, validator, embeddingService, createSilentLogger());
    const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);
    const authService = new AuthorizationService(loadAuthConfig(CONFIG_DIR));
    const resolver = new ContactResolver(contactService, entityMemory, authService, logger);

    const createdContactIds: string[] = [];
    const createdKgNodeIds: string[] = [];

    const trackContact = (contactId: string, kgNodeId?: string | null): void => {
      createdContactIds.push(contactId);
      if (kgNodeId) createdKgNodeIds.push(kgNodeId);
    };

    const trackKgNode = (kgNodeId: string): void => {
      createdKgNodeIds.push(kgNodeId);
    };

    const cleanup = async (): Promise<void> => {
      // FK order: identities / overrides → contacts → kg edges → kg nodes.
      // Never DELETE FROM audit_log — append-only trigger rejects it.
      try {
        if (createdContactIds.length > 0) {
          await pool.query(
            'DELETE FROM contact_channel_identities WHERE contact_id = ANY($1)',
            [createdContactIds],
          );
          await pool.query(
            'DELETE FROM contact_auth_overrides WHERE contact_id = ANY($1)',
            [createdContactIds],
          );
          await pool.query('DELETE FROM contacts WHERE id = ANY($1)', [createdContactIds]);
        }
        if (createdKgNodeIds.length > 0) {
          await pool.query(
            'DELETE FROM kg_edges WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)',
            [createdKgNodeIds],
          );
          // Delete tracked nodes (contact entity nodes and any fact nodes via trackKgNode).
          await pool.query('DELETE FROM kg_nodes WHERE id = ANY($1)', [createdKgNodeIds]);
        }
      } finally {
        await pool.end();
      }
    };

    await pool.query('SELECT 1 FROM contacts LIMIT 0');

    return {
      pool,
      logger,
      entityMemory,
      contactService,
      authService,
      resolver,
      createdContactIds,
      createdKgNodeIds,
      trackContact,
      trackKgNode,
      cleanup,
    };
  } catch (err) {
    // Setup failed after the pool was opened — release connections before rethrowing.
    await pool.end().catch(() => undefined);
    throw err;
  }
}
