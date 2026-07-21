import { describe, it, expect } from 'vitest';
import {
  expandLegacyToolEventTypes,
  isToolResultEventType,
  isToolInvokeEventType,
  readAuditToolName,
} from '../../../src/audit/legacy-tool-events.js';

describe('expandLegacyToolEventTypes', () => {
  it('adds skill.* aliases when filtering on tool.*', () => {
    expect(expandLegacyToolEventTypes(['tool.invoke', 'tool.result'])).toEqual([
      'tool.invoke',
      'skill.invoke',
      'tool.result',
      'skill.result',
    ]);
  });

  it('adds tool.* aliases when filtering on legacy skill.*', () => {
    expect(expandLegacyToolEventTypes(['skill.result', 'autonomy.skill_blocked'])).toEqual([
      'skill.result',
      'tool.result',
      'autonomy.skill_blocked',
      'autonomy.tool_blocked',
    ]);
  });

  it('leaves unrelated event types unchanged', () => {
    expect(expandLegacyToolEventTypes(['agent.task', 'outbound.message'])).toEqual([
      'agent.task',
      'outbound.message',
    ]);
  });

  it('does not duplicate when both vocabularies are already present', () => {
    expect(expandLegacyToolEventTypes(['tool.result', 'skill.result'])).toEqual([
      'tool.result',
      'skill.result',
    ]);
  });
});

describe('isToolResultEventType / isToolInvokeEventType', () => {
  it('recognizes both vocabularies', () => {
    expect(isToolResultEventType('tool.result')).toBe(true);
    expect(isToolResultEventType('skill.result')).toBe(true);
    expect(isToolResultEventType('tool.invoke')).toBe(false);
    expect(isToolInvokeEventType('tool.invoke')).toBe(true);
    expect(isToolInvokeEventType('skill.invoke')).toBe(true);
  });
});

describe('readAuditToolName', () => {
  it('prefers toolName over skillName', () => {
    expect(readAuditToolName({ toolName: 'a', skillName: 'b' })).toBe('a');
  });

  it('falls back to skillName for historical rows', () => {
    expect(readAuditToolName({ skillName: 'email-send' })).toBe('email-send');
  });

  it('returns undefined when neither is present', () => {
    expect(readAuditToolName({})).toBeUndefined();
  });
});
