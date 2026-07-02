// export-controls.test.ts — unit tests for bulk export gates (#201).

import { describe, it, expect } from 'vitest';
import {
  evaluateExportGate,
  DEFAULT_EXPORT_CONTROLS,
  ExportControlService,
  extractExportItemsFromInput,
  extractDestinationFromInput,
  maxItemSensitivity,
} from './export-controls.js';
import type { ExportItem } from './export-controls.js';

function makeItems(
  specs: Array<{ label: string; sensitivity: ExportItem['sensitivity']; nodeId?: string }>,
): ExportItem[] {
  return specs.map((s) => ({ label: s.label, sensitivity: s.sensitivity, nodeId: s.nodeId }));
}

describe('evaluateExportGate', () => {
  const config = { ...DEFAULT_EXPORT_CONTROLS, confidentialThreshold: 3 };

  it('allows export below confidential threshold', () => {
    const items = makeItems([
      { label: 'a', sensitivity: 'confidential' },
      { label: 'b', sensitivity: 'internal' },
    ]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'drive_folder', folderId: 'allowed-folder' },
      config: { ...config, allowedDestinations: { driveFolderIds: ['allowed-folder'], urls: [], filePaths: [] } },
    });
    expect(result.action).toBe('allow');
  });

  it('requires approval when confidential+ count exceeds threshold', () => {
    const items = makeItems([
      { label: 'a', sensitivity: 'confidential' },
      { label: 'b', sensitivity: 'confidential' },
      { label: 'c', sensitivity: 'confidential' },
      { label: 'd', sensitivity: 'confidential' },
    ]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'drive_folder', folderId: 'allowed-folder' },
      config: { ...config, allowedDestinations: { driveFolderIds: ['allowed-folder'], urls: [], filePaths: [] } },
    });
    expect(result.action).toBe('approval_required');
    if (result.action === 'approval_required') {
      expect(result.code).toBe('confidential_threshold');
    }
  });

  it('allows threshold exceedance when humanApproved', () => {
    const items = makeItems([
      { label: 'a', sensitivity: 'confidential' },
      { label: 'b', sensitivity: 'confidential' },
      { label: 'c', sensitivity: 'confidential' },
      { label: 'd', sensitivity: 'confidential' },
    ]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'drive_folder', folderId: 'allowed-folder' },
      config: { ...config, allowedDestinations: { driveFolderIds: ['allowed-folder'], urls: [], filePaths: [] } },
      humanApproved: true,
    });
    expect(result.action).toBe('allow');
  });

  it('requires confirmation for unknown non-contact destination', () => {
    const items = makeItems([{ label: 'report.pdf', sensitivity: 'internal' }]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'drive_folder', folderId: 'unknown-folder-xyz' },
      config,
    });
    expect(result.action).toBe('approval_required');
    if (result.action === 'approval_required') {
      expect(result.code).toBe('unknown_destination');
    }
  });

  it('does not apply destination allowlist to email recipients', () => {
    const items = makeItems([{ label: 'a', sensitivity: 'internal' }]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'email', address: 'stranger@example.com' },
      config,
    });
    expect(result.action).toBe('allow');
  });

  it('blocks bulk restricted export regardless of approval', () => {
    const items = makeItems([
      { label: 'creds', sensitivity: 'restricted' },
      { label: 'board', sensitivity: 'restricted' },
    ]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'drive_folder', folderId: 'allowed' },
      config: { ...config, allowedDestinations: { driveFolderIds: ['allowed'], urls: [], filePaths: [] } },
      humanApproved: true,
    });
    expect(result.action).toBe('block');
    if (result.action === 'block') {
      expect(result.code).toBe('restricted_bulk');
    }
  });

  it('requires approval for a single restricted item', () => {
    const items = makeItems([{ label: 'creds', sensitivity: 'restricted' }]);
    const result = evaluateExportGate({
      items,
      destination: { kind: 'spreadsheet', spreadsheetId: 'sheet-1' },
      config: { ...config, allowedDestinations: { driveFolderIds: ['sheet-1'], urls: [], filePaths: [] } },
    });
    expect(result.action).toBe('approval_required');
    if (result.action === 'approval_required') {
      expect(result.code).toBe('restricted_single');
    }
  });
});

describe('extractExportItemsFromInput', () => {
  it('derives one item per attachment on email-send', () => {
    const raw = extractExportItemsFromInput('email-send', {
      attachments: [
        { file_url: 'file:///tmp/a.pdf', filename: 'a.pdf', content_type: 'application/pdf' },
        { file_url: 'file:///tmp/b.pdf', filename: 'b.pdf', content_type: 'application/pdf', node_id: 'node-1' },
      ],
    });
    expect(raw).toHaveLength(2);
    expect(raw[0]?.label).toBe('a.pdf');
    expect(raw[1]?.node_id).toBe('node-1');
  });

  it('counts append_table_rows values as items', () => {
    const raw = extractExportItemsFromInput('append_table_rows', {
      values: [['a'], ['b'], ['c']],
    });
    expect(raw).toHaveLength(3);
  });
});

describe('extractDestinationFromInput', () => {
  it('extracts drive folder from create_drive_file', () => {
    const dest = extractDestinationFromInput('create_drive_file', { folder_id: 'abc123' });
    expect(dest).toEqual({ kind: 'drive_folder', folderId: 'abc123' });
  });

  it('defaults create_drive_file destination to root when folder_id absent', () => {
    const dest = extractDestinationFromInput('create_drive_file', { file_name: 'x.pdf' });
    expect(dest).toEqual({ kind: 'drive_folder', folderId: 'root' });
  });
});

describe('ExportControlService.formatItemSummary', () => {
  it('formats items with sensitivity tags', () => {
    const summary = ExportControlService.formatItemSummary(
      makeItems([
        { label: 'Q2 revenue', sensitivity: 'confidential', nodeId: 'n-1' },
        { label: 'notes.pdf', sensitivity: 'internal' },
      ]),
    );
    expect(summary).toContain('Q2 revenue');
    expect(summary).toContain('[confidential]');
    expect(summary).toContain('notes.pdf');
  });
});

describe('maxItemSensitivity', () => {
  it('returns the highest sensitivity among items', () => {
    expect(maxItemSensitivity(makeItems([
      { label: 'a', sensitivity: 'internal' },
      { label: 'b', sensitivity: 'restricted' },
    ]))).toBe('restricted');
  });
});
