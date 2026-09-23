// resumable-accumulator-spill.ts — spill inline resumable accumulators into the OKF workspace (#1210 / #1819).
//
// When progress.resumable.accumulator exceeds the inline cap (#1172), the overflow is
// written to a workspace document and replaced with a { kind: "document", path } pointer.

import type { WorkingDocsRepo } from './working-docs-repo.js';
import { markdownFenceFor } from '../memory/okf.js';
import {
  allocateUniqueProjectSlugAsync,
  projectDirectoryPrefix,
  resolveOwnedWorkspacePrefix,
  suggestProjectSlug,
} from '../agents/document-placement.js';
import { documentPointerFromProgress } from '../agents/document-workspace.js';
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

/** Workspace path for a spilled accumulator under a resolved directory prefix. */
export function accumulatorDocPath(workspacePrefix: string): string {
  const prefix = workspacePrefix.endsWith('/') ? workspacePrefix : `${workspacePrefix}/`;
  return `${prefix}${ACCUMULATOR_DOC_LEAF}`;
}

/** Serialize an inline accumulator value into OKF markdown body text. */
export function formatAccumulatorDocumentBody(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  const fence = markdownFenceFor(serialized);
  return [
    '# Accumulator',
    '',
    'Checkpoint spill from `progress.resumable`. After the initial spill, grow this document',
    'with `doc-write` and keep the resumable block\'s accumulator as the document pointer.',
    '',
    `${fence}json`,
    serialized,
    fence,
    '',
  ].join('\n');
}

export interface SpillInlineAccumulatorParams {
  rootTaskId: string;
  /** Resolved `/projects/<slug>/` (or legacy UUID) directory prefix. */
  workspacePrefix: string;
  agentId?: string;
  inlineValue: unknown;
}

/** Write (or replace) the spilled accumulator document and return its pointer. */
export async function spillInlineAccumulator(
  repo: WorkingDocsRepo,
  params: SpillInlineAccumulatorParams,
): Promise<ResumableDocumentPointer> {
  const path = accumulatorDocPath(params.workspacePrefix);
  const body = formatAccumulatorDocumentBody(params.inlineValue);

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await repo.read(path);
    if (!existing) {
      try {
        await repo.create({
          path,
          type: ACCUMULATOR_DOC_TYPE,
          body,
          taskId: params.rootTaskId,
          agentId: params.agentId,
        });
        return documentAccumulatorPointer(path);
      } catch {
        // Another writer created accumulator.md between read and create — retry.
        continue;
      }
    }

    const result = await repo.update(path, {
      body,
      expectedVersion: existing.version,
      taskId: params.rootTaskId,
    });
    if (result.ok) {
      return documentAccumulatorPointer(path);
    }
  }

  throw new Error(`resumable-accumulator-spill: failed to write ${path} after retries`);
}

export interface PrepareResumableBlockWithSpillParams {
  workingDocsRepo: WorkingDocsRepo;
  rootTaskId: string;
  taskId: string;
  agentId?: string;
  /** Root task title — used to suggest a slug when no workspace exists yet. */
  title?: string;
  /** Optional already-resolved workspace prefix (skips ownership lookup). */
  workspacePrefix?: string;
}

/** Resolve spill directory: owned/legacy prefix, else uniqueness-allocated suggested slug. */
export async function resolveSpillWorkspacePrefix(
  params: PrepareResumableBlockWithSpillParams,
  progress?: unknown,
): Promise<string> {
  if (params.workspacePrefix) {
    return params.workspacePrefix.endsWith('/')
      ? params.workspacePrefix
      : `${params.workspacePrefix}/`;
  }

  const pointer = documentPointerFromProgress(progress);
  const ownedDocuments = await params.workingDocsRepo.listLiveByTaskId(params.rootTaskId);
  const legacyPrefix = projectDirectoryPrefix(params.rootTaskId);
  const legacyUuidDocuments = await params.workingDocsRepo.listByPrefix(legacyPrefix);

  const resolved = resolveOwnedWorkspacePrefix({
    rootTaskId: params.rootTaskId,
    pointer,
    ownedDocuments,
    legacyUuidDocuments,
  });
  if (resolved) return resolved;

  const suggested = suggestProjectSlug(params.title ?? 'project');
  const allocated = await allocateUniqueProjectSlugAsync(
    suggested,
    params.rootTaskId,
    async (slug) => {
      const docs = await params.workingDocsRepo.listByPrefix(projectDirectoryPrefix(slug));
      return docs.length > 0;
    },
  );
  return projectDirectoryPrefix(allocated);
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

  const workspacePrefix = await resolveSpillWorkspacePrefix(spill);
  const path = accumulatorDocPath(workspacePrefix);
  const pointer = documentAccumulatorPointer(path);
  const preparedPointer = prepareResumableBlock({ ...input, accumulator: pointer });
  if (!preparedPointer.ok) return preparedPointer;

  await spillInlineAccumulator(spill.workingDocsRepo, {
    rootTaskId: spill.rootTaskId,
    workspacePrefix,
    agentId: spill.agentId,
    inlineValue: input.accumulator,
  });

  return preparedPointer;
}
