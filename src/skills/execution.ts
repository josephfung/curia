// execution.ts — the execution layer runs skills within controlled boundaries.
//
// This is the security boundary between agents and the outside world.
// It resolves skills from the registry, validates permissions, provides
// a sandboxed SkillContext, enforces timeouts, and sanitizes outputs.
//
// Normal skills get: validated input, scoped secret access, a scoped logger.
// They cannot access the bus, database, or filesystem directly.
//
// Infrastructure skills (manifest.infrastructure: true) additionally receive
// bus and agent registry access. This effectively grants unrestricted bus
// publish/subscribe including layer impersonation. Only framework-internal
// skills like 'delegate' should use this — it is a privileged escape hatch.

import type { SkillResult, SkillContext } from './types.js';
import type { SkillRegistry } from './registry.js';
import { sanitizeOutput } from './sanitize.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundGateway } from './outbound-gateway.js';
import type { HeldMessageService } from '../contacts/held-messages.js';

export class ExecutionLayer {
  private registry: SkillRegistry;
  private logger: Logger;
  private bus?: EventBus;
  private agentRegistry?: AgentRegistry;
  private contactService?: ContactService;
  private outboundGateway?: OutboundGateway;
  private heldMessages?: HeldMessageService;

  constructor(registry: SkillRegistry, logger: Logger, options?: { bus?: EventBus; agentRegistry?: AgentRegistry; contactService?: ContactService; outboundGateway?: OutboundGateway; heldMessages?: HeldMessageService }) {
    this.registry = registry;
    this.logger = logger;
    this.bus = options?.bus;
    this.agentRegistry = options?.agentRegistry;
    this.contactService = options?.contactService;
    this.outboundGateway = options?.outboundGateway;
    this.heldMessages = options?.heldMessages;
  }

  /**
   * Invoke a skill by name with the given input.
   *
   * Steps:
   * 1. Resolve the skill from the registry
   * 2. Build a sandboxed SkillContext with scoped secret access
   * 3. Execute the handler with a timeout
   * 4. Sanitize the output (strip injection vectors, redact secrets, truncate)
   * 5. Return the result
   *
   * Never throws — always returns a SkillResult.
   */
  async invoke(
    skillName: string,
    input: Record<string, unknown>,
  ): Promise<SkillResult> {
    const skill = this.registry.get(skillName);

    if (!skill) {
      return { success: false, error: `Skill '${skillName}' not found in registry` };
    }

    const { manifest, handler } = skill;
    const skillLogger = this.logger.child({ skill: skillName });

    // Build the sandboxed context — secret access is restricted to
    // only the secrets declared in the skill's manifest
    const declaredSecrets = new Set(manifest.secrets);
    const ctx: SkillContext = {
      input,
      secret: (name: string): string => {
        if (!declaredSecrets.has(name)) {
          throw new Error(`Secret '${name}' is not declared in the manifest for skill '${skillName}'`);
        }
        const value = process.env[name];
        if (!value) {
          throw new Error(`Secret '${name}' is declared but not set in the environment`);
        }
        // Log at debug level — info is too noisy for every secret access
        skillLogger.debug({ secretName: name }, 'Secret accessed');
        return value;
      },
      log: skillLogger,
    };

    // Infrastructure skills get bus and agent registry access.
    // This is intentionally gated behind a manifest flag so normal skills
    // cannot escalate their privileges by accessing the bus directly.
    if (manifest.infrastructure) {
      if (!this.bus || !this.agentRegistry) {
        skillLogger.error(
          { skillName },
          'Infrastructure skill invoked but ExecutionLayer was not constructed with bus/agentRegistry/contactService',
        );
        return {
          success: false,
          error: `Infrastructure skill '${skillName}' cannot run: bus, agent registry, or contactService not available in ExecutionLayer — ensure all three are passed to the ExecutionLayer constructor`,
        };
      }
      ctx.bus = this.bus;
      ctx.agentRegistry = this.agentRegistry;
      ctx.contactService = this.contactService;
      // outboundGateway is optional — only skills that send external messages need it.
      // All outbound communication goes through the gateway, which enforces contact
      // blocked checks and content filtering before dispatch.
      if (this.outboundGateway) {
        ctx.outboundGateway = this.outboundGateway;
      }
      // heldMessages is optional — only held-message skills need it
      if (this.heldMessages) {
        ctx.heldMessages = this.heldMessages;
      }
    }

    skillLogger.info({ input: Object.keys(input) }, 'Invoking skill');

    // Track the timeout timer so we can clean it up after the race resolves.
    // Without cleanup, successful skill invocations leak timers that keep the
    // process alive during graceful shutdown.
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<SkillResult>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Skill '${skillName}' timed out after ${manifest.timeout}ms`)),
        manifest.timeout,
      );
    });

    try {
      const result = await Promise.race([
        handler.execute(ctx),
        timeoutPromise,
      ]);

      // Sanitize successful output before returning
      if (result.success && typeof result.data === 'string') {
        return { success: true, data: sanitizeOutput(result.data) };
      } else if (result.success && result.data !== null && result.data !== undefined) {
        const sanitized = sanitizeOutput(JSON.stringify(result.data));
        try {
          return { success: true, data: JSON.parse(sanitized) };
        } catch (parseErr) {
          // Sanitization broke the JSON (e.g., truncation mid-key) — return as string
          skillLogger.warn({ err: parseErr, skillName }, 'Sanitized output is not valid JSON, returning as string');
          return { success: true, data: sanitized };
        }
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skillLogger.error({ err }, 'Skill invocation failed');
      return { success: false, error: message };
    } finally {
      // Clean up the timeout timer whether we succeeded, failed, or timed out
      clearTimeout(timer!);
    }
  }
}
