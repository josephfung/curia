import { describe, expect, it } from 'vitest';
import { applyReach } from '../../scenarios/reach.js';

describe('applyReach', () => {
  const offered = new Set(['skill-activate', 'tool-registry', 'email-send']);

  it('adds skill-activate tools test mode cannot serve to unavailable (#2059)', () => {
    const reach = applyReach({
      offered,
      unavailable: new Set(),
      activated: ['doc-read', 'notes-add'],
      discovered: ['drive-download-file'],
      missingCapabilities: tool => (tool === 'doc-read' || tool === 'drive-download-file' ? ['tempFileStore'] : []),
    });

    expect(reach.reachable.has('doc-read')).toBe(true);
    expect(reach.unavailable.has('doc-read')).toBe(true);
    expect(reach.reachable.has('notes-add')).toBe(true);
    expect(reach.unavailable.has('notes-add')).toBe(false);
    // Discovered tools keep the same rule (#2050).
    expect(reach.unavailable.has('drive-download-file')).toBe(true);
  });

  it('does not count activated tools when skill-activate itself cannot run', () => {
    const withoutTool = applyReach({
      offered: new Set(['email-send']),
      unavailable: new Set(),
      activated: ['doc-read'],
      discovered: [],
      missingCapabilities: () => ['tempFileStore'],
    });
    expect(withoutTool.reachable.has('doc-read')).toBe(false);
    expect(withoutTool.unavailable.has('doc-read')).toBe(false);

    const toolUnavailable = applyReach({
      offered,
      unavailable: new Set(['skill-activate']),
      activated: ['doc-read'],
      discovered: [],
      missingCapabilities: () => ['tempFileStore'],
    });
    expect(toolUnavailable.reachable.has('doc-read')).toBe(false);
    expect(toolUnavailable.unavailable.has('doc-read')).toBe(false);
    expect(toolUnavailable.unavailable.has('skill-activate')).toBe(true);
  });

  it('keeps an offered unservable tool unavailable', () => {
    const reach = applyReach({
      offered,
      unavailable: new Set(['email-list']),
      activated: [],
      discovered: [],
      missingCapabilities: () => [],
    });
    expect(reach.unavailable.has('email-list')).toBe(true);
    expect(reach.reachable.has('email-send')).toBe(true);
  });
});
