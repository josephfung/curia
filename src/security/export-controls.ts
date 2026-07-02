// export-controls.ts — bulk export gates for attachments and MCP record exports (#201).
//
// Enforces three controls shared by OutboundGateway (email attachments) and the
// ExecutionLayer (Google Workspace MCP tools):
//   1. Item-count threshold — >N confidential+ items → human approval
//   2. Destination allowlisting — unknown non-contact sinks → human approval
//   3. Sensitivity ceiling — bulk restricted export hard-blocked (no approval path)
//
// Channel-recipient trust (email/Signal) is NOT duplicated here — Stage 2.5 disclosure
// gating in OutboundGateway handles contact-tier checks for prose recipients.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { Sensitivity } from '../memory/types.js';
import { SENSITIVITY_LEVELS } from '../memory/types.js';
import { isConfidentialOrAbove, isRestricted, sensitivityRank } from '../memory/sensitivity.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ExportControlsConfig {
  /** Max confidential+ items per invocation before CEO approval. Default: 10. */
  confidentialThreshold: number;
  /** Allowlisted non-contact export sinks (Drive folders, URLs, file paths). */
  allowedDestinations: {
    driveFolderIds: string[];
    urls: string[];
    filePaths: string[];
  };
}

export const DEFAULT_EXPORT_CONTROLS: ExportControlsConfig = {
  confidentialThreshold: 10,
  allowedDestinations: {
    driveFolderIds: [],
    urls: [],
    filePaths: [],
  },
};

export function resolveExportControls(
  yaml: {
    exportControls?: {
      confidentialThreshold?: number;
      allowedDestinations?: {
        driveFolderIds?: string[];
        urls?: string[];
        filePaths?: string[];
      };
    };
  } | undefined,
): ExportControlsConfig {
  const raw = yaml?.exportControls;
  const threshold = raw?.confidentialThreshold;
  return {
    confidentialThreshold:
      typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 1
        ? Math.floor(threshold)
        : DEFAULT_EXPORT_CONTROLS.confidentialThreshold,
    allowedDestinations: {
      driveFolderIds: raw?.allowedDestinations?.driveFolderIds ?? [],
      urls: raw?.allowedDestinations?.urls ?? [],
      filePaths: raw?.allowedDestinations?.filePaths ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Export item / destination types
// ---------------------------------------------------------------------------

/** One discrete exported record or attachment with a resolved sensitivity. */
export interface ExportItem {
  /** KG node ID when the item maps to graph data. */
  nodeId?: string;
  /** Human-readable label (filename, fact label, row summary). */
  label: string;
  sensitivity: Sensitivity;
}

export type ExportDestination =
  | { kind: 'email'; address: string }
  | { kind: 'signal'; address: string }
  | { kind: 'drive_folder'; folderId: string }
  | { kind: 'spreadsheet'; spreadsheetId: string }
  | { kind: 'url'; url: string }
  | { kind: 'file_path'; path: string };

export type ExportGateOutcome =
  | { action: 'allow' }
  | { action: 'block'; code: 'restricted_bulk'; message: string; items: ExportItem[] }
  | { action: 'approval_required'; code: 'confidential_threshold' | 'restricted_single' | 'unknown_destination'; message: string; items: ExportItem[]; destination: string };

// Skills that export countable records via MCP (second enforcement point).
export const MCP_EXPORT_SKILLS = new Set([
  'create_drive_file',
  'create_sheet',
  'append_table_rows',
]);

// Skills that route attachments through OutboundGateway.
export const GATEWAY_ATTACHMENT_SKILLS = new Set([
  'email-send',
  'email-reply',
  'email-draft-save',
  'send-draft',
]);

// ---------------------------------------------------------------------------
// Pure policy evaluation
// ---------------------------------------------------------------------------

export function evaluateExportGate(opts: {
  items: ExportItem[];
  destination: ExportDestination;
  config: ExportControlsConfig;
  humanApproved?: boolean;
}): ExportGateOutcome {
  const { items, destination, config, humanApproved } = opts;

  if (items.length === 0) {
    return { action: 'allow' };
  }

  const restrictedCount = items.filter((i) => isRestricted(i.sensitivity)).length;
  if (restrictedCount > 1) {
    return {
      action: 'block',
      code: 'restricted_bulk',
      message:
        `Bulk export blocked: ${restrictedCount} restricted items cannot be exported together. ` +
        `Share restricted data one item at a time with explicit per-item confirmation.`,
      items,
    };
  }

  if (!humanApproved && restrictedCount === 1) {
    return {
      action: 'approval_required',
      code: 'restricted_single',
      message:
        'Export requires approval: this action includes 1 restricted item. ' +
        'Confirm you intend to share this specific item.',
      items,
      destination: formatDestination(destination),
    };
  }

  const confidentialCount = items.filter((i) => isConfidentialOrAbove(i.sensitivity)).length;
  if (!humanApproved && confidentialCount > config.confidentialThreshold) {
    return {
      action: 'approval_required',
      code: 'confidential_threshold',
      message:
        `Export requires approval: ${confidentialCount} confidential-or-higher items ` +
        `exceed the threshold of ${config.confidentialThreshold}.`,
      items,
      destination: formatDestination(destination),
    };
  }

  if (!humanApproved && isNonContactSink(destination) && !isDestinationAllowlisted(destination, config)) {
    return {
      action: 'approval_required',
      code: 'unknown_destination',
      message:
        `Export requires approval: destination "${formatDestination(destination)}" is not on the ` +
        `allowed destinations list.`,
      items,
      destination: formatDestination(destination),
    };
  }

  return { action: 'allow' };
}

export function formatDestination(destination: ExportDestination): string {
  switch (destination.kind) {
    case 'email':
      return destination.address;
    case 'signal':
      return destination.address;
    case 'drive_folder':
      return `drive:folder:${destination.folderId}`;
    case 'spreadsheet':
      return `sheets:${destination.spreadsheetId}`;
    case 'url':
      return destination.url;
    case 'file_path':
      return destination.path;
  }
}

function isNonContactSink(destination: ExportDestination): boolean {
  return destination.kind === 'drive_folder'
    || destination.kind === 'spreadsheet'
    || destination.kind === 'url'
    || destination.kind === 'file_path';
}

function isDestinationAllowlisted(
  destination: ExportDestination,
  config: ExportControlsConfig,
): boolean {
  const allowed = config.allowedDestinations;
  switch (destination.kind) {
    case 'drive_folder':
      return allowed.driveFolderIds.includes(destination.folderId);
    case 'spreadsheet':
      // Treat spreadsheet IDs like Drive folder IDs for allowlist purposes.
      return allowed.driveFolderIds.includes(destination.spreadsheetId);
    case 'url':
      return allowed.urls.some((u) => destination.url === u || destination.url.startsWith(u));
    case 'file_path':
      return allowed.filePaths.some((p) => destination.path === p || destination.path.startsWith(p));
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Input extraction — build items + destination from skill / gateway payloads
// ---------------------------------------------------------------------------

interface RawExportItemInput {
  node_id?: string;
  nodeId?: string;
  label?: string;
  sensitivity?: string;
}

function parseRawExportItems(raw: unknown): RawExportItemInput[] {
  if (!Array.isArray(raw)) return [];
  const result: RawExportItemInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    result.push({
      node_id: typeof obj['node_id'] === 'string' ? obj['node_id'] : undefined,
      nodeId: typeof obj['nodeId'] === 'string' ? obj['nodeId'] : undefined,
      label: typeof obj['label'] === 'string' ? obj['label'] : undefined,
      sensitivity: typeof obj['sensitivity'] === 'string' ? obj['sensitivity'] : undefined,
    });
  }
  return result;
}

function parseSensitivity(value: string | undefined): Sensitivity | undefined {
  if (!value) return undefined;
  return (SENSITIVITY_LEVELS as readonly string[]).includes(value)
    ? (value as Sensitivity)
    : undefined;
}

function countRows(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.length;
}

/**
 * Extract export items from a skill input. Uses explicit `export_items` when present;
 * otherwise derives a count from attachments / table rows with default `internal` sensitivity.
 */
export function extractExportItemsFromInput(
  skillName: string,
  input: Record<string, unknown>,
): RawExportItemInput[] {
  const explicit = parseRawExportItems(input['export_items']);
  if (explicit.length > 0) return explicit;

  if (GATEWAY_ATTACHMENT_SKILLS.has(skillName)) {
    const attachments = input['attachments'];
    if (!Array.isArray(attachments)) return [];
    return attachments.map((att, i) => {
      if (typeof att !== 'object' || att === null) {
        return { label: `attachment[${i}]` };
      }
      const obj = att as Record<string, unknown>;
      const filename = typeof obj['filename'] === 'string' ? obj['filename'] : `attachment[${i}]`;
      const nodeId = typeof obj['node_id'] === 'string' ? obj['node_id'] : undefined;
      const sensitivity = typeof obj['sensitivity'] === 'string' ? obj['sensitivity'] : undefined;
      return { label: filename, node_id: nodeId, sensitivity };
    });
  }

  if (skillName === 'create_drive_file') {
    const fileName = typeof input['file_name'] === 'string'
      ? input['file_name']
      : typeof input['filename'] === 'string'
        ? input['filename']
        : 'drive file';
    return [{ label: fileName }];
  }

  if (skillName === 'create_sheet') {
    const title = typeof input['title'] === 'string' ? input['title'] : 'new sheet';
    return [{ label: title }];
  }

  if (skillName === 'append_table_rows') {
    const rowCount = countRows(input['values']) || countRows(input['rows']);
    if (rowCount === 0) return [];
    return Array.from({ length: rowCount }, (_, i) => ({ label: `row ${i + 1}` }));
  }

  return [];
}

/** Derive the export destination from skill input. */
export function extractDestinationFromInput(
  skillName: string,
  input: Record<string, unknown>,
): ExportDestination | null {
  if (GATEWAY_ATTACHMENT_SKILLS.has(skillName)) {
    const to = input['to'];
    if (typeof to === 'string' && to.trim()) {
      return { kind: 'email', address: to.trim() };
    }
    if (skillName === 'email-reply') {
      // Reply destination is implicit in reply_to_message_id — channel tier gate handles trust.
      return null;
    }
    return null;
  }

  if (skillName === 'signal-send') {
    const recipient = input['recipient'];
    if (typeof recipient === 'string' && recipient.trim()) {
      return { kind: 'signal', address: recipient.trim() };
    }
    return null;
  }

  if (skillName === 'create_drive_file') {
    const folderId = input['folder_id'] ?? input['folderId'];
    if (typeof folderId === 'string' && folderId.trim()) {
      return { kind: 'drive_folder', folderId: folderId.trim() };
    }
    return { kind: 'drive_folder', folderId: 'root' };
  }

  if (skillName === 'create_sheet' || skillName === 'append_table_rows') {
    const spreadsheetId = input['spreadsheet_id'] ?? input['spreadsheetId'];
    if (typeof spreadsheetId === 'string' && spreadsheetId.trim()) {
      return { kind: 'spreadsheet', spreadsheetId: spreadsheetId.trim() };
    }
    return null;
  }

  return null;
}

export function extractDestinationFromEmailRequest(
  to: string,
): ExportDestination {
  return { kind: 'email', address: to };
}

// ---------------------------------------------------------------------------
// Service — resolves node sensitivities from the database
// ---------------------------------------------------------------------------

export class ExportControlService {
  constructor(
    private readonly pool: Pool,
    private readonly config: ExportControlsConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve raw export item inputs to fully-tagged ExportItems, looking up
   * kg_nodes.sensitivity for any node IDs present.
   */
  async resolveItems(rawItems: RawExportItemInput[]): Promise<ExportItem[]> {
    if (rawItems.length === 0) return [];

    const nodeIds = rawItems
      .map((r) => r.node_id ?? r.nodeId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const nodeMap = await this.loadNodeSensitivities(nodeIds);

    return rawItems.map((raw, index) => {
      const nodeId = raw.node_id ?? raw.nodeId;
      const fromDb = nodeId ? nodeMap.get(nodeId) : undefined;
      const explicitSensitivity = parseSensitivity(raw.sensitivity);
      const sensitivity: Sensitivity = explicitSensitivity
        ?? fromDb?.sensitivity
        ?? 'internal';
      const label = raw.label?.trim()
        || fromDb?.label
        || (nodeId ? `node ${nodeId}` : `item ${index + 1}`);
      return { nodeId, label, sensitivity };
    });
  }

  async evaluateSkillExport(opts: {
    skillName: string;
    input: Record<string, unknown>;
    humanApproved?: boolean;
  }): Promise<ExportGateOutcome | null> {
    if (!MCP_EXPORT_SKILLS.has(opts.skillName) && !GATEWAY_ATTACHMENT_SKILLS.has(opts.skillName)) {
      return null;
    }

    const rawItems = extractExportItemsFromInput(opts.skillName, opts.input);
    if (rawItems.length === 0) return null;

    const destination = extractDestinationFromInput(opts.skillName, opts.input);
    if (!destination) {
      // No destination to gate (e.g. email-reply) — item-count / restricted checks still apply
      // with a placeholder destination for audit messaging.
      const items = await this.resolveItems(rawItems);
      return evaluateExportGate({
        items,
        destination: { kind: 'email', address: '(implicit reply)' },
        config: this.config,
        humanApproved: opts.humanApproved,
      });
    }

    const items = await this.resolveItems(rawItems);
    return evaluateExportGate({
      items,
      destination,
      config: this.config,
      humanApproved: opts.humanApproved,
    });
  }

  async evaluateGatewayAttachments(opts: {
    attachments: Array<{ filename: string; nodeId?: string; sensitivity?: string }>;
    destination: ExportDestination;
    exportItems?: RawExportItemInput[];
    humanApproved?: boolean;
  }): Promise<ExportGateOutcome | null> {
    const rawItems = opts.exportItems && opts.exportItems.length > 0
      ? opts.exportItems
      : opts.attachments.map((a) => ({
        label: a.filename,
        node_id: a.nodeId,
        sensitivity: a.sensitivity,
      }));

    if (rawItems.length === 0) return null;

    const items = await this.resolveItems(rawItems);
    return evaluateExportGate({
      items,
      destination: opts.destination,
      config: this.config,
      humanApproved: opts.humanApproved,
    });
  }

  /** Build a CEO-readable summary of export items for approval notifications. */
  static formatItemSummary(items: ExportItem[]): string {
    const lines = items.map((item) => {
      const tag = item.sensitivity;
      const id = item.nodeId ? ` (${item.nodeId})` : '';
      return `• ${item.label}${id} [${tag}]`;
    });
    return lines.join('\n');
  }

  private async loadNodeSensitivities(
    nodeIds: string[],
  ): Promise<Map<string, { sensitivity: Sensitivity; label: string }>> {
    const map = new Map<string, { sensitivity: Sensitivity; label: string }>();
    if (nodeIds.length === 0) return map;

    try {
      const result = await this.pool.query<{ id: string; label: string; sensitivity: string }>(
        `SELECT id, label, sensitivity FROM kg_nodes WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [nodeIds],
      );
      for (const row of result.rows) {
        const sensitivity = parseSensitivity(row.sensitivity) ?? 'internal';
        map.set(row.id, { sensitivity, label: row.label });
      }
    } catch (err) {
      // Fail-closed: treat unresolved nodes as confidential so a DB outage does not
      // silently permit bulk exfiltration.
      this.logger.error({ err, nodeIdCount: nodeIds.length }, 'export-controls: kg_nodes lookup failed — failing closed');
      for (const id of nodeIds) {
        if (!map.has(id)) {
          map.set(id, { sensitivity: 'confidential', label: `node ${id}` });
        }
      }
    }
    return map;
  }
}

/** Sort items by sensitivity descending for audit payloads. */
export function maxItemSensitivity(items: ExportItem[]): Sensitivity {
  let max: Sensitivity = 'public';
  for (const item of items) {
    if (sensitivityRank(item.sensitivity) > sensitivityRank(max)) {
      max = item.sensitivity;
    }
  }
  return max;
}
