// handler.ts — list-user-secrets skill (#1497).
//
// Names-only, `user.*`-only vault discovery. The execution layer injects
// `ctx.listUserSecretNames`, which is structurally scoped to the user namespace
// (SQL prefix + allowlist + in-handler filter). This skill has no code path that
// reads a secret value.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { USER_SECRET_PREFIX } from '../../src/secrets/user-secret-name.js';

export class ListUserSecretsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.listUserSecretNames) {
      return { success: false, error: 'list-user-secrets requires the userSecretIndex capability in context.' };
    }

    try {
      const names = await ctx.listUserSecretNames();
      // Defense in depth: even if the capability ever leaked a non-user name,
      // this skill must not surface it to the agent.
      const keys = names
        .filter(n => typeof n === 'string' && n.startsWith(USER_SECRET_PREFIX))
        .sort();

      return {
        success: true,
        data: {
          keys,
          count: keys.length,
          summary: keys.length === 0
            ? 'No personal (user.*) secrets are stored yet. Use secret-capture-request to mint a capture link.'
            : `These are vault key names only — never values. Pass an exact key to secret-capture-request to update it in place, or to web-browser as secret_ref. Do not guess names, and do not ask the user to re-enter a secret that is already listed.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'list-user-secrets failed');
      return { success: false, error: message };
    }
  }
}
