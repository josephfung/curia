// scripts/render-coordinator-prompt.ts
// Renders the Coordinator system prompt to stdout: the exact system string
// AgentRuntime sends for an ordinary principal chat turn, built against a live
// database. Output is a plain text file suitable for promptfoo's system prompt
// target.
//
// Usage:
//   pnpm render-coordinator-prompt > tests/redteam/coordinator-system-prompt.txt
//   (expands to: tsx --env-file=.env scripts/render-coordinator-prompt.ts)
//
// The output file is gitignored — it may contain production identity details,
// security directives, and internal routing instructions.
//
// The prompt comes from the production assembly path (src/startup/agent-assembly.ts
// + src/agents/system-prompt.ts, via the test-mode stack), so it includes every
// block the runtime adds — pinned SKILL.md bodies, autonomy band, date guardrail,
// turn budget — in runtime order. Nothing here assembles blocks itself (#1966).
//
// Re-run when any of the following change:
//   - agents/coordinator.yaml, or any SKILL.md the coordinator pins
//   - Office identity (wizard / PUT /api/identity) or the autonomy score
//   - security.trust_thresholds in config/default.yaml
//   - Specialist agents (agents/*.yaml) or their registry enablement
//
// Requires: DATABASE_URL in .env pointing at a migrated Curia instance. No LLM API
// key is needed — providers are offline. Writes only the idempotent bootstrap rows
// a normal boot writes (office identity, agent contact).

import { createTestModeStack } from '../src/startup/test-mode-stack.js';
import { createSilentLogger } from '../src/logger.js';

async function main(): Promise<void> {
  const stack = await createTestModeStack({ llm: 'offline', logger: createSilentLogger() });
  try {
    if (!stack.principalContactId) {
      process.stderr.write(
        'render-coordinator-prompt: warning: no principal contact found (system_role=principal).\n' +
        '  The Principal Contact Details block is absent, as it would be in production.\n',
      );
    }
    process.stdout.write(await stack.renderSystemPrompt('coordinator') + '\n');
  } finally {
    try {
      await stack.shutdown();
    } catch (err: unknown) {
      // Don't let teardown shadow a real error — the prompt may already be written.
      process.stderr.write(`render-coordinator-prompt: warning: shutdown failed: ${String(err)}\n`);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`render-coordinator-prompt: fatal error\n${String(err)}\n`);
  process.exit(1);
});
