// reembed-kg.ts — re-embeds the knowledge graph with the configured embedding model (ADR-051).
//   pnpm reembed:kg            re-embed, resizing kg_nodes.embedding if the width changed
//   pnpm reembed:kg --dry-run  report what would change, and change nothing
//   pnpm reembed:kg --force    re-embed every row even when its stamp matches (an endpoint whose
//                              weights changed under the same model name); combine with --dry-run to count them
// Run it with Curia stopped, after the boot log says the graph is off. Docker Compose recipe: docs/dev/setup.md.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { loadConfig, loadYamlConfig } from '../src/config.js';
import { createPool } from '../src/db/connection.js';
import { REEMBED_APPLICATION_NAME, describeInstanceLockHolder } from '../src/db/instance-lock.js';
import { loadEncryptionKey } from '../src/secrets/crypto.js';
import { SecretsService } from '../src/secrets/secrets-service.js';
import { applyVaultSecrets } from '../src/secrets/apply-vault-secrets.js';
import {
  EmbeddingService,
  describeEmbeddingUnavailable,
  describeImplicitOpenAIDeprecation,
  resolveEmbedding,
} from '../src/memory/embedding.js';
import { hashBundledWeights } from '../src/memory/embedding-onnx.js';
import { reembedKnowledgeGraph } from '../src/memory/reembed.js';
import {
  REEMBED_COMMAND,
  REEMBED_DOCKER_NOTE,
  readEmbeddingSchema,
  storedStateFromSnapshot,
} from '../src/memory/embedding-schema.js';

const logger = pino({ name: 'reembed-kg', level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const config = loadConfig();
  const yamlConfig = loadYamlConfig(path.resolve(import.meta.dirname, '../config'));
  const pool = createPool(config.databaseUrl, logger, { applicationName: REEMBED_APPLICATION_NAME });
  try {
    await applyVaultSecrets(config, new SecretsService(pool, loadEncryptionKey(), logger), logger);
    // Resolution reads what the graph holds, as boot does, so the command re-embeds toward
    // the model boot would pick. Switching models means setting the variables first.
    const snapshot = await readEmbeddingSchema(pool);
    const embedding = resolveEmbedding(config, yamlConfig.embedding?.profiles, storedStateFromSnapshot(snapshot));
    if (!embedding.ok) {
      logger.error(`reembed-kg: ${describeEmbeddingUnavailable(embedding)}.`);
      return 1;
    }
    if (embedding.deprecation === 'implicit_openai') logger.warn(`reembed-kg: ${describeImplicitOpenAIDeprecation()}`);

    let embeddingService: EmbeddingService;
    try {
      // The bundled model's stamp carries the hash of the weights actually loaded.
      const profile = embedding.source.kind === 'bundled'
        ? { ...embedding.profile, weightsSha256: await hashBundledWeights(embedding.source.modelDir, logger) }
        : embedding.profile;
      embeddingService = await EmbeddingService.create(embedding.source, profile, logger);
    } catch (err) {
      if (embedding.source.kind !== 'bundled') throw err;
      logger.error({ err }, `reembed-kg: the bundled embedding model is unusable: ${(err as Error).message}. Nothing was changed.`);
      return 1;
    }

    const result = await reembedKnowledgeGraph({ pool, embeddingService, logger, dryRun, force });
    switch (result.status) {
      case 'locked':
        logger.error(
          { holder: result.holder },
          `reembed-kg: Curia appears to be running: the instance lock is held by ${describeInstanceLockHolder(result.holder)}. ` +
          `Stop Curia, run ${REEMBED_COMMAND} again, then start Curia. ${REEMBED_DOCKER_NOTE} Nothing was changed.`,
        );
        return 1;
      case 'dry_run':
        logger.info(
          { rowsToEmbed: result.rowsToEmbed, widthChanges: result.widthChanges, force: result.force },
          'reembed-kg: DRY-RUN complete — nothing was changed',
        );
        return 0;
      case 'done':
        return 0;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not process.exit(): exiting while the bundled model's onnxruntime-node session
  // is still alive can abort in its native teardown (libc++abi "recursive_mutex lock failed",
  // exit 134; see scripts/embedding-eval.ts), turning a finished re-embed into a failure.
  // main() ends the pool in its finally, so nothing holds the event loop and the process
  // exits on its own once it drains.
  main()
    .then(code => { process.exitCode = code; })
    .catch((err: unknown) => {
      logger.error({ err }, 'reembed-kg: failed');
      process.exitCode = 1;
    });
}
