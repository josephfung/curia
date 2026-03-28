// types.ts — type definitions for the skill system.
//
// Skills are Curia's extension mechanism — how agents interact with the
// outside world. These types define the contract between skills and the
// execution layer. Skills implement SkillHandler; the execution layer
// provides SkillContext and expects SkillResult.

import type { Logger } from '../logger.js';

/**
 * Skill manifest shape — loaded from skill.json files in each skill directory.
 * Declares what the skill does, what it needs, and its security classification.
 */
export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  /** "normal" = auto-approvable; "elevated" = requires human approval on first use */
  sensitivity: 'normal' | 'elevated';
  /** JSON Schema-ish description of expected inputs */
  inputs: Record<string, string>;
  /** JSON Schema-ish description of outputs */
  outputs: Record<string, string>;
  /** Declared capabilities — validated at load time */
  permissions: string[];
  /** Env var names the skill needs access to via ctx.secret() */
  secrets: string[];
  /** Per-invocation timeout in ms. Default 30000. */
  timeout: number;
  /** If true, this skill receives bus and agent registry access in its context.
   *  This grants unrestricted bus publish/subscribe including layer impersonation.
   *  Only for framework-internal skills like 'delegate' — external skills should never set this. */
  infrastructure?: boolean;
}

/**
 * The sandboxed context passed to every skill invocation.
 * Skills cannot access the bus, database, or filesystem directly —
 * they receive inputs through ctx.input and return outputs via SkillResult.
 */
export interface SkillContext {
  /** Validated input matching the manifest's inputs declaration */
  input: Record<string, unknown>;
  /** Scoped secret access — only secrets declared in the manifest are accessible */
  secret(name: string): string;
  /** Scoped pino child logger */
  log: Logger;
  /** Bus access — only available to infrastructure skills (manifest.infrastructure: true) */
  bus?: import('../bus/bus.js').EventBus;
  /** Agent registry — only available to infrastructure skills */
  agentRegistry?: import('../agents/agent-registry.js').AgentRegistry;
  /** Contact service — only available to infrastructure skills */
  contactService?: import('../contacts/contact-service.js').ContactService;
  /** Outbound gateway — only available to infrastructure skills. All external
   *  communication (email, future Signal/Telegram) goes through the gateway,
   *  which enforces contact blocked checks and content filtering. */
  outboundGateway?: import('./outbound-gateway.js').OutboundGateway;
  /** Held message service for infrastructure skills that manage held messages */
  heldMessages?: import('../contacts/held-messages.js').HeldMessageService;
}

/**
 * Discriminated union for skill results.
 * Skills NEVER throw — they return success or failure as a value.
 * This makes error handling explicit and prevents unhandled exceptions
 * from propagating through the execution layer.
 */
export type SkillResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/**
 * Interface that all skill handlers implement.
 * The execute method receives a sandboxed SkillContext and returns a SkillResult.
 */
export interface SkillHandler {
  execute(ctx: SkillContext): Promise<SkillResult>;
}

/**
 * Internal registry entry — combines manifest metadata with the loaded handler.
 * The registry stores these; the execution layer looks them up by name.
 */
export interface RegisteredSkill {
  manifest: SkillManifest;
  handler: SkillHandler;
}

/**
 * Tool definition format expected by LLM providers (Anthropic, OpenAI).
 * Generated from SkillManifest data so agents never need to know the
 * internal manifest format.
 *
 * Defined here (not in provider.ts) because it's the canonical shared type
 * between the skill registry and the LLM provider layer.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}
