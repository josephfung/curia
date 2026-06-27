// resumable-progress.ts — typed read/write helpers for tasks.progress.resumable.
//
// Shared representation for the runtime and the checkpoint primitive (#1173).
// Persisted under the existing tasks.progress JSONB — no schema migration.

/** Max serialized size (UTF-8 bytes) of an inline accumulator value. */
export const RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES = 4096;

/** Max serialized size (UTF-8 bytes) of the entire resumable block. */
export const RESUMABLE_BLOCK_MAX_BYTES = 8192;

/** Opaque cursor — LLM-authored position in the collection being iterated. */
export type ResumableCursor = string | Record<string, unknown> | null;

/** Spill target when the inline accumulator exceeds its cap (#1210). */
export interface ResumableDocumentPointer {
  kind: 'document';
  path: string;
  section?: string;
}

export type ResumableInlineAccumulator = unknown;

export type ResumableAccumulator = ResumableInlineAccumulator | ResumableDocumentPointer;

export interface ResumableProgressBlock {
  cursor: ResumableCursor;
  done: number;
  total: number;
  accumulator: ResumableAccumulator;
  lastSliceUnits: number;
  next: string;
  /** ISO timestamp of the last checkpoint write. */
  checkpointedAt?: string;
}

export interface TaskProgress {
  notes?: Array<{ at: string; note: string }>;
  resumable?: ResumableProgressBlock;
  [key: string]: unknown;
}

export type ResumableWriteResult =
  | { ok: true; block: ResumableProgressBlock; progress: TaskProgress }
  | { ok: false; code: 'inline_accumulator_overflow'; bytes: number; maxBytes: number }
  | { ok: false; code: 'block_overflow'; bytes: number; maxBytes: number }
  | { ok: false; code: 'invalid_block'; message: string };

export function isDocumentPointer(value: unknown): value is ResumableDocumentPointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj.kind === 'document' && typeof obj.path === 'string' && obj.path.length > 0
    && (obj.section === undefined || typeof obj.section === 'string');
}

export function serializedUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function inlineAccumulatorBytes(value: unknown): number {
  return serializedUtf8Bytes(value);
}

export function isInlineAccumulatorWithinCap(value: unknown): boolean {
  return inlineAccumulatorBytes(value) <= RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES;
}

export function resumableBlockBytes(block: ResumableProgressBlock): number {
  return serializedUtf8Bytes(block);
}

export function isResumableBlockWithinCap(block: ResumableProgressBlock): boolean {
  return resumableBlockBytes(block) <= RESUMABLE_BLOCK_MAX_BYTES;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function parseCursor(raw: unknown): ResumableCursor | undefined {
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (isPlainObject(raw)) {
    return isJsonSerializable(raw) ? raw : undefined;
  }
  return undefined;
}

function parseNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    return undefined;
  }
  return raw;
}

function parseNext(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAccumulator(raw: unknown): ResumableAccumulator | undefined {
  if (raw !== undefined && isPlainObject(raw) && raw.kind === 'document') {
    return isDocumentPointer(raw) ? raw : undefined;
  }
  if (raw === undefined) return undefined;
  // Any JSON-serializable inline value (array, object, string, number, etc.).
  return isJsonSerializable(raw) ? (raw as ResumableInlineAccumulator) : undefined;
}

/** Parse a resumable block from persisted progress JSON. Returns null when absent or invalid. */
export function parseResumableBlock(raw: unknown): ResumableProgressBlock | null {
  if (!isPlainObject(raw)) return null;

  const cursor = parseCursor(raw.cursor);
  const done = parseNonNegativeInt(raw.done);
  const total = parseNonNegativeInt(raw.total);
  const lastSliceUnits = parseNonNegativeInt(raw.lastSliceUnits ?? raw.last_slice_units);
  const next = parseNext(raw.next);
  const accumulator = parseAccumulator(raw.accumulator);

  if (
    cursor === undefined
    || done === undefined
    || total === undefined
    || lastSliceUnits === undefined
    || next === undefined
    || accumulator === undefined
  ) {
    return null;
  }

  const block: ResumableProgressBlock = {
    cursor,
    done,
    total,
    accumulator,
    lastSliceUnits,
    next,
  };

  if (typeof raw.checkpointedAt === 'string') {
    block.checkpointedAt = raw.checkpointedAt;
  } else if (typeof raw.checkpointed_at === 'string') {
    block.checkpointedAt = raw.checkpointed_at;
  }

  return block;
}

/** Read the resumable block from a task progress object. */
export function readResumableBlock(progress: Record<string, unknown>): ResumableProgressBlock | null {
  return parseResumableBlock(progress.resumable);
}

function validateAccumulatorForWrite(accumulator: ResumableAccumulator): ResumableWriteResult | null {
  if (isDocumentPointer(accumulator)) return null;
  const bytes = inlineAccumulatorBytes(accumulator);
  if (bytes > RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES) {
    return {
      ok: false,
      code: 'inline_accumulator_overflow',
      bytes,
      maxBytes: RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
    };
  }
  return null;
}

function validateBlockForWrite(block: ResumableProgressBlock): ResumableWriteResult | null {
  const accError = validateAccumulatorForWrite(block.accumulator);
  if (accError) return accError;

  const bytes = resumableBlockBytes(block);
  if (bytes > RESUMABLE_BLOCK_MAX_BYTES) {
    return {
      ok: false,
      code: 'block_overflow',
      bytes,
      maxBytes: RESUMABLE_BLOCK_MAX_BYTES,
    };
  }
  return null;
}

export interface PrepareResumableBlockInput {
  cursor: ResumableCursor;
  done: number;
  total: number;
  accumulator: ResumableAccumulator;
  lastSliceUnits: number;
  next: string;
  checkpointedAt?: string;
}

/** Validate and normalize a resumable block before persistence. */
export function prepareResumableBlock(input: PrepareResumableBlockInput): ResumableWriteResult {
  const parsed = parseResumableBlock({
    cursor: input.cursor,
    done: input.done,
    total: input.total,
    accumulator: input.accumulator,
    lastSliceUnits: input.lastSliceUnits,
    next: input.next,
    checkpointedAt: input.checkpointedAt,
  });

  if (!parsed) {
    return { ok: false, code: 'invalid_block', message: 'resumable block failed validation' };
  }

  const block: ResumableProgressBlock = {
    ...parsed,
    checkpointedAt: input.checkpointedAt ?? new Date().toISOString(),
  };

  const capError = validateBlockForWrite(block);
  if (capError) return capError;

  return { ok: true, block, progress: {} };
}

/** Merge a validated resumable block into an existing progress object (preserves notes, etc.). */
export function mergeResumableIntoProgress(
  progress: Record<string, unknown>,
  block: ResumableProgressBlock,
): TaskProgress {
  return { ...progress, resumable: block };
}

/** Validate, merge, and return the updated progress object. */
export function writeResumableBlock(
  progress: Record<string, unknown>,
  input: PrepareResumableBlockInput,
): ResumableWriteResult {
  const prepared = prepareResumableBlock(input);
  if (!prepared.ok) return prepared;

  const merged = mergeResumableIntoProgress(progress, prepared.block);
  const mergedBytes = serializedUtf8Bytes(merged.resumable);
  if (mergedBytes > RESUMABLE_BLOCK_MAX_BYTES) {
    return {
      ok: false,
      code: 'block_overflow',
      bytes: mergedBytes,
      maxBytes: RESUMABLE_BLOCK_MAX_BYTES,
    };
  }

  return { ok: true, block: prepared.block, progress: merged };
}

/** Build a document pointer accumulator (used after spill in #1210). */
export function documentAccumulatorPointer(path: string, section?: string): ResumableDocumentPointer {
  const pointer: ResumableDocumentPointer = { kind: 'document', path };
  if (section !== undefined) pointer.section = section;
  return pointer;
}
