import { describe, it, expect } from 'vitest';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('Bus Permissions', () => {
  it('allows channel to publish inbound.message', () => {
    expect(canPublish('channel', 'inbound.message')).toBe(true);
  });
  it('blocks channel from publishing agent.task', () => {
    expect(canPublish('channel', 'agent.task')).toBe(false);
  });
  it('blocks channel from publishing agent.response', () => {
    expect(canPublish('channel', 'agent.response')).toBe(false);
  });
  it('allows dispatch to publish agent.task', () => {
    expect(canPublish('dispatch', 'agent.task')).toBe(true);
  });
  it('allows dispatch to publish outbound.message', () => {
    expect(canPublish('dispatch', 'outbound.message')).toBe(true);
  });
  it('allows agent to publish agent.response', () => {
    expect(canPublish('agent', 'agent.response')).toBe(true);
  });
  it('blocks agent from publishing outbound.message', () => {
    expect(canPublish('agent', 'outbound.message')).toBe(false);
  });
  it('allows system layer to publish anything', () => {
    expect(canPublish('system', 'inbound.message')).toBe(true);
    expect(canPublish('system', 'agent.task')).toBe(true);
    expect(canPublish('system', 'agent.response')).toBe(true);
    expect(canPublish('system', 'outbound.message')).toBe(true);
  });
  it('allows channel to subscribe to outbound.message', () => {
    expect(canSubscribe('channel', 'outbound.message')).toBe(true);
  });
  it('blocks channel from subscribing to agent.task', () => {
    expect(canSubscribe('channel', 'agent.task')).toBe(false);
  });
});
