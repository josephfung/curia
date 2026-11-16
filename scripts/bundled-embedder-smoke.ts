// bundled-embedder-smoke.ts — proves entity memory works on the bundled embedding model with
// no network (#2023). tests/docker/test-bundled-embedder-egress.sh runs it inside the built
// image on a Docker network with no route out, so any outbound call fails the run.
//
//   DATABASE_URL=postgres://… tsx scripts/bundled-embedder-smoke.ts
//
// It resolves the embedding source exactly as boot does (resolveKnowledgeGraphEmbedding, the
// same env-derived config and YAML profiles), wires the same EntityMemory stack as
// src/index.ts, stores one fact, reads it back by entity and by semantic search, then
// archives both nodes. Exit 0 on success; non-zero, with the reason, otherwise. The last
// stdout line is one JSON object carrying the resolved source, model and process RSS.
//
// Run it against a migrated, throwaway database: it writes (and archives) a test entity.
// It does not run migrations itself; the egress test applies them first, as install.sh does.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { loadConfig, loadYamlConfig } from '../src/config.js';
import { createPool } from '../src/db/connection.js';
import { resolveKnowledgeGraphEmbedding } from '../src/memory/embedding-schema.js';
import type { EmbeddingService } from '../src/memory/embedding.js';
import { embeddingStamp } from '../src/memory/embedding-profiles.js';
import { KnowledgeGraphStore } from '../src/memory/knowledge-graph.js';
import { MemoryValidator } from '../src/memory/validation.js';
import { EntityMemory } from '../src/memory/entity-memory.js';

// Logs go to stderr so stdout carries only the result line the egress test parses.
const logger = pino({ name: 'bundled-embedder-smoke', level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

const SOURCE = 'script:bundled-embedder-smoke';

async function main(): Promise<number> {
  const config = loadConfig();
  const yamlConfig = loadYamlConfig(path.resolve(import.meta.dirname, '../config'));
  const pool = createPool(config.databaseUrl, logger);
  // Hoisted so the finally can release the ONNX session before the pool ends.
  let service: EmbeddingService | undefined;
  try {
    const embedding = await resolveKnowledgeGraphEmbedding(pool, config, yamlConfig.embedding?.profiles, logger);
    if (!embedding.ok) {
      logger.error(
        { gate: embedding.gate, err: 'err' in embedding ? embedding.err : undefined },
        `bundled-embedder-smoke: the knowledge graph is off: ${embedding.message}`,
      );
      return 1;
    }
    service = embedding.service;

    // Same wiring as src/index.ts (no sensitivity classifier: EntityMemory then defaults
    // every node to 'internal', which is all a round-trip needs).
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embedding.service, logger);
    const validator = new MemoryValidator(kgStore, embedding.service);
    const entityMemory = new EntityMemory(kgStore, validator, embedding.service, logger);

    // A unique label so a re-run against the same database never dedups into an old node.
    const runId = randomUUID().slice(0, 8);
    const { entity } = await entityMemory.createEntity({
      type: 'project',
      label: `Embedder smoke ${runId}`,
      properties: {},
      source: SOURCE,
    });
    const factLabel = `The embedder smoke run ${runId} prefers green tea in the morning`;
    const stored = await entityMemory.storeFact({ entityNodeId: entity.id, label: factLabel, source: SOURCE });
    if (!stored.stored || !stored.nodeId) {
      logger.error({ action: stored.action, reason: stored.reason }, 'bundled-embedder-smoke: the fact was not stored');
      return 1;
    }

    try {
      // Read it back two ways: through the entity's edges, and through a vector search,
      // which embeds the query with the same in-process model.
      const queried = await entityMemory.query(entity.id);
      if (!queried.facts.some((f) => f.id === stored.nodeId)) {
        logger.error({ entityId: entity.id, factId: stored.nodeId }, 'bundled-embedder-smoke: query() did not return the stored fact');
        return 1;
      }
      const hits = await entityMemory.search('morning drink preference', { type: 'fact', limit: 5 });
      const hit = hits.find((h) => h.node.id === stored.nodeId);
      if (!hit) {
        logger.error({ factId: stored.nodeId, hits: hits.length }, 'bundled-embedder-smoke: semantic search did not return the stored fact');
        return 1;
      }

      const result = {
        source: embedding.source.kind,
        model: embeddingStamp(embedding.profile),
        dimensions: embedding.profile.dimensions,
        searchScore: Number(hit.score.toFixed(4)),
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } finally {
      // Archive (not delete) both nodes: the store's own retirement path, so a run against a
      // database someone cares about leaves nothing live behind.
      await kgStore.archiveNode(stored.nodeId);
      await entityMemory.archiveEntity(entity.id);
    }
  } finally {
    // Release the native session first: a live onnxruntime-node session at exit can abort
    // the process (exit 134). close() never throws.
    await service?.close();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not process.exit(), as reembed-kg.ts does: main() releases the ONNX session
  // and ends the pool in its finally, so nothing holds the event loop and the process exits
  // on its own once stdout (the result line the egress test parses) has drained.
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err: unknown) => {
      logger.error({ err }, 'bundled-embedder-smoke: failed');
      process.exitCode = 1;
    });
}
