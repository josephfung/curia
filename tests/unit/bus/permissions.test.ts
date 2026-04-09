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

  it('agent layer can publish skill.invoke', () => {
    expect(canPublish('agent', 'skill.invoke')).toBe(true);
  });

  it('agent layer can publish skill.result (on behalf of execution layer)', () => {
    expect(canPublish('agent', 'skill.result')).toBe(true);
  });

  it('execution layer can publish skill.result', () => {
    expect(canPublish('execution', 'skill.result')).toBe(true);
  });

  it('agent layer can subscribe to skill.result', () => {
    expect(canSubscribe('agent', 'skill.result')).toBe(true);
  });

  it('execution layer can subscribe to skill.invoke', () => {
    expect(canSubscribe('execution', 'skill.invoke')).toBe(true);
  });

  it('channel layer cannot publish skill events', () => {
    expect(canPublish('channel', 'skill.invoke')).toBe(false);
    expect(canPublish('channel', 'skill.result')).toBe(false);
  });

  it('agent layer can publish agent.error', () => {
    expect(canPublish('agent', 'agent.error')).toBe(true);
  });

  it('dispatch layer can subscribe to agent.error', () => {
    expect(canSubscribe('dispatch', 'agent.error')).toBe(true);
  });

  it('system layer can publish and subscribe to agent.error', () => {
    expect(canPublish('system', 'agent.error')).toBe(true);
    expect(canSubscribe('system', 'agent.error')).toBe(true);
  });

  it('channel layer cannot publish agent.error', () => {
    expect(canPublish('channel', 'agent.error')).toBe(false);
  });

  // Explicit cross-layer violation cases called out in issue #187.
  // These confirm the hard boundaries between layers are enforced correctly.
  // (channel/skill.invoke and channel/agent.task are already covered above.)

  it('dispatch layer cannot publish skill.result', () => {
    // skill.result is owned by execution (and agent on its behalf); dispatch has no publish right
    expect(canPublish('dispatch', 'skill.result')).toBe(false);
  });

  it('dispatch layer cannot publish skill.invoke', () => {
    // skill.invoke is an agent-layer responsibility; dispatch cannot trigger skills directly
    expect(canPublish('dispatch', 'skill.invoke')).toBe(false);
  });

  it('execution layer cannot publish agent.task', () => {
    // execution only emits skill.result; it has no routing authority
    expect(canPublish('execution', 'agent.task')).toBe(false);
  });

  // llm.call — spec 10, published by agent layer only

  it('agent layer can publish llm.call', () => {
    expect(canPublish('agent', 'llm.call')).toBe(true);
  });

  it('dispatch layer cannot publish llm.call', () => {
    // LLM calls are made by the agent runtime, not the dispatch layer
    expect(canPublish('dispatch', 'llm.call')).toBe(false);
  });

  it('channel layer cannot publish llm.call', () => {
    expect(canPublish('channel', 'llm.call')).toBe(false);
  });

  it('execution layer cannot publish llm.call', () => {
    expect(canPublish('execution', 'llm.call')).toBe(false);
  });

  it('system layer can publish and subscribe to llm.call', () => {
    expect(canPublish('system', 'llm.call')).toBe(true);
    expect(canSubscribe('system', 'llm.call')).toBe(true);
  });

  // human.decision — spec 10, published by dispatch layer only

  it('dispatch layer can publish human.decision', () => {
    expect(canPublish('dispatch', 'human.decision')).toBe(true);
  });

  it('agent layer cannot publish human.decision', () => {
    // approval gates are enforced at the dispatch layer, not by agents
    expect(canPublish('agent', 'human.decision')).toBe(false);
  });

  it('channel layer cannot publish human.decision', () => {
    expect(canPublish('channel', 'human.decision')).toBe(false);
  });

  it('execution layer cannot publish human.decision', () => {
    expect(canPublish('execution', 'human.decision')).toBe(false);
  });

  it('system layer can publish and subscribe to human.decision', () => {
    expect(canPublish('system', 'human.decision')).toBe(true);
    expect(canSubscribe('system', 'human.decision')).toBe(true);
  });
});
