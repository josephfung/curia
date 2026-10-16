// smoke-bedrock-tool-use.ts — live smoke gate for Bedrock tool-calling reliability.
//
// Drives the real BedrockProvider against the live Bedrock endpoint under a load shaped
// like the coordinator's: a system prompt of at least 10K tokens and at least 40 tools.
// That combination is what silently broke tool-calling for one candidate model during
// the ADR-041 search — it narrated the call as prose or JSON instead of emitting a real
// Converse toolUse block, and Converse reports that as an ordinary successful reply, so
// nothing but this check notices. The model passed every isolated test.
//
// Needs live AWS credentials in the vault and a reachable Postgres, so it is NOT part of
// `pnpm test`. Run it whenever a tier is mapped to a Bedrock model, and when that model
// changes:
//
//   pnpm run smoke:bedrock-tools                       # the standard tier's model
//   pnpm run smoke:bedrock-tools -- --model <id> --runs 5
//
// Fails loudly, never skips: exit 0 only when every run produced a real tool call. Missing
// credentials, a missing region, a model that is not on Bedrock, a provider error and a
// narrated call are all exit 1 with the reason printed.

import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../src/secrets/crypto.js';
import { SecretsService } from '../src/secrets/secrets-service.js';
import { loadYamlConfig } from '../src/config.js';
import { ModelRegistry } from '../src/agents/llm/model-registry.js';
import { BedrockProvider, detectUncalledToolIntent } from '../src/agents/llm/bedrock.js';
import { estimateTokens, estimateToolDefinitionsTokens } from '../src/agents/llm/token-estimator.js';
import type { LLMResponse } from '../src/agents/llm/provider.js';
import type { ToolDefinition } from '../src/skills/types.js';

/** Minimum load, matching issue #1766. The coordinator runs at ~12K tokens and ~48 tools. */
export const MIN_SYSTEM_PROMPT_TOKENS = 10_000;
export const MIN_TOOL_COUNT = 40;
export const DEFAULT_RUNS = 5;

export const TARGET_TOOL: ToolDefinition = {
  name: 'scheduler_list',
  description: 'List all scheduled jobs, optionally filtered by status or agent_id.',
  input_schema: { type: 'object', properties: { status: { type: 'string' }, agent_id: { type: 'string' } } },
};

export const SMOKE_USER_MESSAGE =
  'What scheduled jobs do you currently have running? List them with their cron schedules.';

function makeDummyTool(i: number): ToolDefinition {
  return {
    name: `dummy_tool_${i}`,
    description: `A placeholder tool number ${i} for load testing. It does not do anything real.`,
    input_schema: { type: 'object', properties: { arg: { type: 'string', description: 'a placeholder argument' } } },
  };
}

export interface SmokeFixture {
  systemPrompt: string;
  tools: ToolDefinition[];
  systemPromptTokens: number;
  toolDefinitionTokens: number;
}

/**
 * Build the load. Exact wording is irrelevant; the token and tool counts are what matter, so
 * the prompt is measured with the same estimator the runtime uses and grown until it clears
 * the floor.
 */
export function buildSmokeFixture(): SmokeFixture {
  const paragraph =
    'You are the coordinator for an executive office. Route requests to the right specialist, keep '
    + 'answers short and factual, never invent data you were not given, and when a question can be '
    + 'answered by one of your tools, call that tool instead of describing what you would do. ';
  let systemPrompt = '';
  while (estimateTokens(systemPrompt) < MIN_SYSTEM_PROMPT_TOKENS) {
    systemPrompt += paragraph;
  }
  const tools = [...Array.from({ length: MIN_TOOL_COUNT + 7 }, (_, i) => makeDummyTool(i)), TARGET_TOOL];
  return {
    systemPrompt,
    tools,
    systemPromptTokens: estimateTokens(systemPrompt),
    toolDefinitionTokens: estimateToolDefinitionsTokens(tools),
  };
}

export type SmokeVerdict =
  | { pass: true }
  | { pass: false; reason: 'narrated_tool_call' | 'text_instead_of_tool_call' | 'wrong_tool' | 'provider_error'; detail: string };

/** Judge one response. Only a real tool_use naming the target tool passes. */
export function judgeResponse(result: LLMResponse, offeredToolNames: string[]): SmokeVerdict {
  if (result.type === 'tool_use') {
    return result.toolCalls.some((tc) => tc.name === TARGET_TOOL.name)
      ? { pass: true }
      : { pass: false, reason: 'wrong_tool', detail: `called ${result.toolCalls.map((tc) => tc.name).join(', ')}` };
  }
  if (result.type === 'text') {
    const narrated = detectUncalledToolIntent(result.content, offeredToolNames);
    return narrated
      ? { pass: false, reason: 'narrated_tool_call', detail: `described a call to ${narrated} instead of making it` }
      : { pass: false, reason: 'text_instead_of_tool_call', detail: result.content.slice(0, 300) };
  }
  return { pass: false, reason: 'provider_error', detail: result.error.message };
}

export interface SmokeArgs {
  model: string | undefined;
  runs: number;
}

/** Parse `--model <id>` and `--runs <n>`. Throws on a malformed value rather than ignoring it. */
export function parseArgs(argv: string[]): SmokeArgs {
  let model: string | undefined;
  let runs = DEFAULT_RUNS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model') {
      model = argv[++i];
      if (!model) throw new Error('--model needs a value');
    } else if (arg === '--runs') {
      const value = argv[++i];
      runs = Number.parseInt(value ?? '', 10);
      if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got: ${value}`);
    } else if (arg !== '--') {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { model, runs };
}

const logger = pino({ name: 'smoke-bedrock-tool-use' });

async function main(): Promise<number> {
  const { model: modelArg, runs } = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('FAIL — DATABASE_URL is not set, so AWS credentials cannot be read from the vault');
    return 1;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  let accessKeyId: string | null;
  let secretAccessKey: string | null;
  try {
    const secrets = new SecretsService(pool, loadEncryptionKey(), logger);
    [accessKeyId, secretAccessKey] = await Promise.all([
      secrets.get('aws_access_key_id'),
      secrets.get('aws_secret_access_key'),
    ]);
  } finally {
    await pool.end();
  }
  if (!accessKeyId || !secretAccessKey) {
    logger.error('FAIL — aws_access_key_id / aws_secret_access_key are not in the vault; this gate cannot be skipped');
    return 1;
  }

  const region = process.env.AWS_REGION?.trim();
  if (!region) {
    logger.error('FAIL — AWS_REGION is not set');
    return 1;
  }
  const timeoutSeconds = Number.parseInt(process.env.AWS_BEDROCK_TIMEOUT ?? '120', 10);
  // Same bounds as loadConfig(): a NaN or out-of-range value would make setTimeout fire
  // almost immediately and every run would be misreported as a provider error.
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > Math.floor(2_147_483_647 / 1000)) {
    logger.error({ value: process.env.AWS_BEDROCK_TIMEOUT }, 'FAIL — AWS_BEDROCK_TIMEOUT must be a positive number of seconds within the Node timer limit');
    return 1;
  }

  const modelRegistry = new ModelRegistry(logger);
  const model = modelArg
    ?? loadYamlConfig(path.resolve(import.meta.dirname, '../config')).model_routing?.tiers.standard.model;
  if (!model) {
    logger.error('FAIL — no model given and model_routing.tiers.standard.model is not configured');
    return 1;
  }
  if (modelRegistry.getProvider(model) !== 'bedrock') {
    logger.error({ model, provider: modelRegistry.getProvider(model) }, 'FAIL — that model is not a Bedrock model; pass --model <bedrock profile id> or map a tier in local.yaml');
    return 1;
  }

  const fixture = buildSmokeFixture();
  const provider = new BedrockProvider(accessKeyId, secretAccessKey, region, timeoutSeconds * 1000, logger, modelRegistry);
  logger.info(
    { model, runs, toolCount: fixture.tools.length, systemPromptTokens: fixture.systemPromptTokens, toolDefinitionTokens: fixture.toolDefinitionTokens },
    'Sending load-shaped tool-use smoke test',
  );

  const toolNames = fixture.tools.map((t) => t.name);
  let failures = 0;
  for (let run = 1; run <= runs; run++) {
    const result = await provider.chat({
      messages: [
        { role: 'system', content: fixture.systemPrompt },
        { role: 'user', content: SMOKE_USER_MESSAGE },
      ],
      tools: fixture.tools,
      model,
    });
    const verdict = judgeResponse(result, toolNames);
    if (verdict.pass) {
      logger.info({ run }, 'run passed — real tool_use call');
    } else {
      failures++;
      logger.error({ run, reason: verdict.reason, detail: verdict.detail }, 'run FAILED');
    }
  }

  if (failures > 0) {
    logger.error({ model, failures, runs }, `FAIL — ${failures}/${runs} runs did not produce a real tool call; do not route the coordinator's tiers to this model`);
    return 1;
  }
  logger.info({ model, runs }, `PASS — ${runs}/${runs} runs produced a real tool call under production-shaped load`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((err: unknown) => {
      logger.error({ err }, 'smoke-bedrock-tool-use: fatal error');
      process.exit(1);
    });
}
