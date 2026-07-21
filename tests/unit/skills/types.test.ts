import { describe, it, expect } from 'vitest';
import type { ToolResult, ToolManifest } from '../../../src/skills/types.js';

describe('ToolResult discriminated union', () => {
  it('success result carries data', () => {
    const result: ToolResult = { success: true, data: { count: 42 } };
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ count: 42 });
    }
  });

  it('failure result carries error string', () => {
    const result: ToolResult = { success: false, error: 'connection refused' };
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('connection refused');
    }
  });
});

describe('ToolManifest', () => {
  it('represents a complete manifest', () => {
    const manifest: ToolManifest = {
      name: 'test-skill',
      description: 'A test skill',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'none',
      inputs: { query: 'string' },
      outputs: { result: 'string' },
      permissions: ['network:https'],
      secrets: ['API_KEY'],
      timeout: 30000,
    };
    expect(manifest.name).toBe('test-skill');
    expect(manifest.sensitivity).toBe('normal');
  });
});
