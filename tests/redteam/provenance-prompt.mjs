/**
 * Promptfoo prompt function — frames each red-team probe with dispatcher-style
 * provenance before calling the Coordinator target (#900).
 *
 * Usage in promptfooconfig:
 *   prompts:
 *     - file://./provenance-prompt.mjs:renderProvenancePrompt
 *
 * Set REDTEAM_COHORT=external|principal (or pass vars.cohort).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessUrl = pathToFileURL(path.join(__dirname, 'sender-context-harness.ts')).href;

let harnessModule;

async function loadHarness() {
  if (!harnessModule) {
    harnessModule = await import(harnessUrl);
  }
  return harnessModule;
}

/**
 * @param {string | { vars?: Record<string, unknown> }} context
 * @returns {Promise<string>}
 */
export async function renderProvenancePrompt(context) {
  const {
    buildSenderContextBlock,
    buildInboundUserContent,
  } = await loadHarness();

  const vars =
    typeof context === 'object' && context !== null && 'vars' in context
      ? context.vars ?? {}
      : {};

  const cohort = process.env.REDTEAM_COHORT ?? vars.cohort ?? 'external';
  if (cohort !== 'external' && cohort !== 'principal') {
    throw new Error(`Invalid provenance cohort "${cohort}" — expected external or principal`);
  }

  const message =
    typeof context === 'string'
      ? context
      : typeof vars.message === 'string'
        ? vars.message
        : '';

  const coordinatorPath = path.join(__dirname, 'coordinator-system-prompt.txt');
  if (!fs.existsSync(coordinatorPath)) {
    throw new Error(
      'coordinator-system-prompt.txt missing — run: pnpm render-coordinator-prompt > tests/redteam/coordinator-system-prompt.txt',
    );
  }

  const coordinatorPrompt = fs.readFileSync(coordinatorPath, 'utf8');
  const senderContext = buildSenderContextBlock(cohort);
  const userContent = buildInboundUserContent(cohort, message);

  return JSON.stringify([
    { role: 'system', content: coordinatorPrompt },
    { role: 'system', content: senderContext },
    { role: 'user', content: userContent },
  ]);
}
