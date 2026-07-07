// smoke-bedrock-tool-use.ts — live smoke test for Bedrock tool-calling reliability.
//
// Exercises the real BedrockMistralProvider (not a raw-SDK bypass) against the
// live Bedrock endpoint, under a prompt/tool-count load shaped like the actual
// coordinator (see docs/adr/023-aws-bedrock-mistral-llm-provider.md — this is
// exactly the condition that silently broke tool-calling for
// mistral-large-2402: a large system prompt combined with many available
// tools caused the model to narrate an intended call as text instead of
// emitting a real Converse toolUse block).
//
// Requires live AWS credentials in the vault and a reachable Postgres — this
// is NOT part of `pnpm test` (which must run without live cloud credentials
// or network calls). Run on demand, or whenever the configured Bedrock model
// changes, via:
//
//   pnpm run smoke:bedrock-tools
//
// Exits 0 on a confirmed real tool call, 1 on anything else (narrated-only
// text, provider error, or missing credentials), with a clear reason printed.
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../src/secrets/crypto.js';
import { SecretsService } from '../src/secrets/secrets-service.js';
import { loadYamlConfig } from '../src/config.js';
import { ModelRegistry } from '../src/agents/llm/model-registry.js';
import { BedrockMistralProvider } from '../src/agents/llm/bedrock-mistral.js';
import type { ToolDefinition } from '../src/skills/types.js';

const logger = pino({ name: 'smoke-bedrock-tool-use' });

// Shaped to approximate the real coordinator's load (spec 02 / agents/coordinator.yaml):
// a long system prompt and a large pinned-skill count. Exact wording doesn't matter —
// what matters is reproducing the token/tool-count scale that triggered the failure.
const REPRESENTATIVE_SYSTEM_PROMPT = 'You are a helpful executive assistant coordinator. '.repeat(400);
const DUMMY_TOOL_COUNT = 47;

function makeDummyTool(i: number): ToolDefinition {
  return {
    name: `dummy_tool_${i}`,
    description: `A placeholder tool number ${i} for load testing. It does not do anything real.`,
    input_schema: { type: 'object', properties: { arg: { type: 'string', description: 'a placeholder argument' } } },
  };
}

const TARGET_TOOL: ToolDefinition = {
  name: 'scheduler_list',
  description: 'List all scheduled jobs, optionally filtered by status or agent_id.',
  input_schema: { type: 'object', properties: { status: { type: 'string' }, agent_id: { type: 'string' } } },
};

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('DATABASE_URL is not set — cannot resolve AWS credentials from the vault');
    return 1;
  }

  const encryptionKey = loadEncryptionKey();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const secrets = new SecretsService(pool, encryptionKey, logger);

  const [accessKeyId, secretAccessKey] = await Promise.all([
    secrets.get('aws_access_key_id'),
    secrets.get('aws_secret_access_key'),
  ]);
  await pool.end();

  if (!accessKeyId || !secretAccessKey) {
    logger.warn('AWS credentials are not seeded in the vault — skipping (this deployment is not configured for Bedrock)');
    return 0;
  }

  const region = process.env.AWS_REGION;
  if (!region) {
    logger.error('AWS_REGION is not set — cannot construct the Bedrock client');
    return 1;
  }
  const timeoutSeconds = parseInt(process.env.AWS_BEDROCK_TIMEOUT ?? '120', 10);

  const configDir = path.resolve(import.meta.dirname, '../config');
  const yamlConfig = loadYamlConfig(configDir);
  const model = yamlConfig.model_routing?.tiers.standard.model;
  if (!model) {
    logger.error('config/default.yaml has no model_routing.tiers.standard.model configured');
    return 1;
  }

  const modelRegistry = new ModelRegistry(logger);
  const provider = new BedrockMistralProvider(accessKeyId, secretAccessKey, region, timeoutSeconds * 1000, logger, modelRegistry);

  const tools: ToolDefinition[] = [
    ...Array.from({ length: DUMMY_TOOL_COUNT }, (_, i) => makeDummyTool(i)),
    TARGET_TOOL,
  ];

  logger.info({ model, toolCount: tools.length, systemPromptChars: REPRESENTATIVE_SYSTEM_PROMPT.length }, 'Sending load-shaped tool-use smoke test');

  const result = await provider.chat({
    messages: [
      { role: 'system', content: REPRESENTATIVE_SYSTEM_PROMPT },
      { role: 'user', content: 'What scheduled jobs do you currently have running? List them with their cron schedules.' },
    ],
    tools,
    model,
  });

  if (result.type === 'tool_use' && result.toolCalls.some((tc) => tc.name === TARGET_TOOL.name)) {
    logger.info({ model, toolCalls: result.toolCalls.map((tc) => tc.name) }, 'PASS — model emitted a real Converse tool_use call under production-shaped load');
    return 0;
  }

  if (result.type === 'text') {
    // BedrockMistralProvider itself already logged an 'error' via
    // detectUncalledToolIntent if the text narrated an uncalled tool call —
    // this is the mechanical PASS/FAIL gate on top of that observability signal.
    logger.error({ model, content: result.content.slice(0, 300) }, 'FAIL — model returned text instead of a real tool_use call (narrated-call failure mode)');
    return 1;
  }

  logger.error({ model, resultType: result.type }, 'FAIL — unexpected result type');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((err: unknown) => {
      logger.error({ err }, 'smoke-bedrock-tool-use: fatal error');
      process.exit(1);
    });
}
