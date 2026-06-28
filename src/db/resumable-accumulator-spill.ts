// resumable-accumulator-spill.ts — spill inline resumable accumulators into the OKF workspace (#1210).
//
// When progress.resumable.accumulator exceeds the inline cap (#1172), the overflow is
// written to a workspace document and replaced with a { kind: "document", path } pointer.

import type { WorkingDocsRepo } from './working-docs-repo.js';
import {
  documentAccumulatorPointer,
  isDocumentPointer,
  prepareResumableBlock,
  type PrepareResumableBlockInput,
  type ResumableDocumentPointer,
  type ResumableWriteResult,
} from './resumable-progress.js';

export const ACCUMULATOR_DOC_LEAF = 'accumulator.md';
export const ACCUMULATOR_DOC_TYPE = 'resumable-accumulator';

/** Workspace path for a project's spilled accumulator document. */
export function accumulatorDocPath(rootTaskId: string): string {
  return `/projects/${rootTaskId}/${ACCUMULATOR_DOC_LEAF}`;
}

/** Serialize an inline accumulator value into OKF markdown body text. */
export function formatAccumulatorDocumentBody(value: unknown): string {
  return [
    '# Accumulator',
    '',
    'Checkpoint spill from `progress.resumable`. After the initial spill, grow this document',
    'with `doc-write` and keep the resumable block\'s accumulator as the document pointer.',
    '',
    '```json',
    JSON.stringify(value, null, 2),
    '```',
    '',
  ].join('\n');
}

export interface SpillInlineAccumulatorParams {
  rootTaskId: string;
  agentId?: string;
  inlineValue: unknown;
}

/** Write (or replace) the spilled accumulator document and return its pointer. */
export async function spillInlineAccumulator(
  repo: WorkingDocsRepo,
  params: SpillInlineAccumulatorParams,
): Promise<ResumableDocumentPointer> {
  const path = accumulatorDocPath(params.rootTaskId);
  const body = formatAccumulatorDocumentBody(params.inlineValue);
  const existing = await repo.read(path);

  if (!existing) {
    await repo.create({
      path,
      type: ACCUMULATOR_DOC_TYPE,
      body,
      taskId: params.rootTaskId,
      agentId: params.agentId,
    });
    return documentAccumulatorPointer(path);
  }

  let expectedVersion = existing.version;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await repo.update(path, {
      body,
      expectedVersion,
      taskId: params.rootTaskId,
    });
    if (result.ok) {
      return documentAccumulatorPointer(path);
    }
    expectedVersion = result.document.version;
  }

  throw new Error(`resumable-accumulator-spill: failed to update ${path} after retries`);
}

export interface PrepareResumableBlockWithSpillParams {
  workingDocsRepo: WorkingDocsRepo;
  rootTaskId: string;
  taskId: string;
  agentId?: string;
}

/** Validate a resumable block, spilling inline overflow to the workspace when needed. */
export async function prepareResumableBlockWithSpill(
  input: PrepareResumableBlockInput,
  spill: PrepareResumableBlockWithSpillParams,
): Promise<ResumableWriteResult> {
  const first = prepareResumableBlock(input);
  if (first.ok) return first;
  if (first.code !== 'inline_accumulator_overflow') return first;
  if (isDocumentPointer(input.accumulator)) return first;

  const pointer = await spillInlineAccumulator(spill.workingDocsRepo, {
    rootTaskId: spill.rootTaskId,
    agentId: spill.agentId,
    inlineValue: input.accumulator,
  });

  return prepareResumableBlock({ ...input, accumulator: pointer });
}
