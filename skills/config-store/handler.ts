// skills/config-store/handler.ts
//
// Generic key-value configuration store backed by the knowledge graph.
// Value get/set/list delegate to ConfigStore so exact-key semantics live in one
// place (#2252). This handler owns input validation, the meta-index, and the
// skill-facing ToolResult shape.
//
// KG storage model:
//   Namespace anchor: type=concept, label="config:{namespace}"
//     properties: { category: 'config', namespace }
//   Per-key facts on the anchor (via ConfigStore):
//     label=key, properties: { key, value, namespace, exact_key: true }, decayClass=permanent
//   Meta-index anchor: type=concept, label="config-store-index"
//     Per-namespace facts: label=namespace, properties: { key, namespace }, exactKey

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  SEND_SETTING_KEY,
  SEND_SETTING_NAMESPACE,
  checkSendLevelWrite,
} from '../../src/skills/principal-send/send-level.js';

const INDEX_LABEL = 'config-store-index';

export class ConfigStoreHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve', 'list_namespaces'].includes(action)) {
      return {
        success: false,
        error: "Missing or invalid 'action' — must be 'store', 'retrieve', or 'list_namespaces'",
      };
    }

    if (!ctx.entityMemory) {
      ctx.log.error('config-store: entity memory not available — KG may be misconfigured');
      return { success: false, error: 'Knowledge graph not available — cannot access config store' };
    }

    if (action === 'store') return this.store(ctx);
    if (action === 'retrieve') return this.retrieve(ctx);
    return this.listNamespaces(ctx);
  }

  private async store(ctx: ToolContext): Promise<ToolResult> {
    const { namespace, key, value } = ctx.input as {
      namespace?: string;
      key?: string;
      value?: string;
    };

    if (!namespace || typeof namespace !== 'string') {
      return { success: false, error: 'Missing required input: namespace' };
    }
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'Missing required input: key' };
    }
    if (typeof value !== 'string' || value.length === 0) {
      return { success: false, error: 'value must be a non-empty string' };
    }
    if (namespace.length > 100) {
      return { success: false, error: 'namespace must be 100 characters or fewer' };
    }
    if (key.length > 200) {
      return { success: false, error: 'key must be 200 characters or fewer' };
    }
    if (value.length > 2000) {
      return { success: false, error: 'value must be 2000 characters or fewer' };
    }

    // ceo_inbox/sending is keyed by mailbox id (#2475 SF5, B1): a key naming no live mailbox would
    // be ignored by the reader, so the agent would confirm a level with no effect. Refused here,
    // with the live ids and labels, which the success result carries too.
    let mailboxes: Array<{ id: string; label: string }> | undefined;
    if (isSendLevelKey(namespace, key) && ctx.principalMailboxes) {
      const live = await liveMailboxes(ctx);
      if (!live.ok) return { success: false, error: live.error };
      const check = checkSendLevelWrite(value, live.mailboxes);
      if (!check.ok) {
        ctx.log.info({ namespace, key }, 'config-store: ceo_inbox/sending write refused — not keyed by live mailbox ids with valid levels');
        return { success: false, error: check.error };
      }
      mailboxes = live.mailboxes.map(({ id, label }) => ({ id, label }));
    }

    // Use the context-aware source key so the rate limit counter matches what
    // AgentRuntime.resetRateLimit() clears. Without this, the counter accumulates
    // globally under 'skill:config-store' and is never reset.
    const writeSource = ctx.memoryWriteSource ?? 'skill:config-store';
    if (!ctx.memoryWriteSource) {
      ctx.log.debug({ namespace, key }, 'config-store: memoryWriteSource not set — using skill:config-store fallback');
    }

    let storeResult: { stored: boolean; action: string };

    try {
      // quiet: ConfigStore would otherwise duplicate the warn/error lines below.
      const configStore = new ConfigStore(ctx.entityMemory!, ctx.log);
      storeResult = await configStore.set(namespace, key, value, {
        confidence: 1.0,
        source: writeSource,
        anchorSource: 'skill:config-store',
        quiet: true,
      });

      if (!storeResult.stored) {
        ctx.log.warn(
          { namespace, key, action: storeResult.action },
          'Config value not written — storeFact rejected the write',
        );
      } else {
        ctx.log.info({ namespace, key, action: storeResult.action }, 'Stored config value');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, namespace, key }, 'Failed to store config value');
      return { success: false, error: `Failed to store: ${message}` };
    }

    // Phase 2: register the namespace in the meta-index (best-effort), but only
    // when the value write was actually accepted.
    if (storeResult.stored) {
      try {
        await this.registerNamespace(ctx, namespace, writeSource);
      } catch (err) {
        ctx.log.error(
          { err, namespace, key },
          'Config value stored but meta-index registration failed — list_namespaces may not include this namespace',
        );
      }
    } else {
      ctx.log.debug(
        { namespace, key, action: storeResult.action },
        'Skipping namespace registration — value write was not accepted',
      );
    }

    return { success: true, data: { stored: storeResult.stored, action: storeResult.action, namespace, key, ...(mailboxes ? { mailboxes } : {}) } };
  }

  private async retrieve(ctx: ToolContext): Promise<ToolResult> {
    const { namespace, key } = ctx.input as { namespace?: string; key?: string };

    if (!namespace || typeof namespace !== 'string') {
      return { success: false, error: 'Missing required input: namespace' };
    }

    try {
      const configStore = new ConfigStore(ctx.entityMemory!, ctx.log);

      if (key) {
        const value = await configStore.get(namespace, key);
        // The send level is keyed by mailbox id: the read names the live ones (#2475 B1).
        let mailboxes: Array<{ id: string; label: string }> | undefined;
        if (isSendLevelKey(namespace, key) && ctx.principalMailboxes) {
          const live = await liveMailboxes(ctx);
          if (live.ok) mailboxes = live.mailboxes.map(({ id, label }) => ({ id, label }));
        }
        const extra = mailboxes ? { mailboxes } : {};
        if (value === null) {
          return { success: true, data: { found: false, key, ...extra } };
        }
        ctx.log.info({ namespace, key }, 'Retrieved config value');
        return { success: true, data: { found: true, key, value, ...extra } };
      }

      const entries = await configStore.list(namespace);
      if (entries.length === 0) {
        // Distinguish empty namespace from never-written: list returns [] for both.
        // Preserve the prior "not stored yet" message when the anchor is absent.
        const anchors = await ctx.entityMemory!.findEntities(`config:${namespace}`);
        if (anchors.length === 0) {
          ctx.log.debug({ namespace }, 'Namespace anchor not found — no config stored yet');
          return {
            success: true,
            data: {
              entries: [],
              message: `No config stored in namespace '${namespace}' yet.`,
            },
          };
        }
      }

      ctx.log.info({ namespace, entryCount: entries.length }, 'Retrieved config entries');
      return { success: true, data: { entries } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, namespace }, 'Failed to retrieve config');
      return { success: false, error: `Failed to retrieve: ${message}` };
    }
  }

  private async listNamespaces(ctx: ToolContext): Promise<ToolResult> {
    let indexNodeIds: string[] | undefined;
    try {
      const indexNodes = await ctx.entityMemory!.findEntities(INDEX_LABEL);

      if (indexNodes.length === 0) {
        return { success: true, data: { namespaces: [] } };
      }

      indexNodeIds = indexNodes.map((n) => n.id);
      const allFacts = await Promise.all(indexNodes.map((n) => ctx.entityMemory!.getFacts(n.id)));
      const namespaces = [
        ...new Set(
          allFacts.flat().map((f) =>
            (f.properties.key as string | undefined)
            ?? (f.properties.namespace as string | undefined)
            ?? f.label
          ),
        ),
      ];

      ctx.log.info({ namespaceCount: namespaces.length }, 'Listed config namespaces');
      return { success: true, data: { namespaces } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, indexNodeIds }, 'Failed to list namespaces');
      return { success: false, error: `Failed to list namespaces: ${message}` };
    }
  }

  private async registerNamespace(ctx: ToolContext, namespace: string, writeSource: string): Promise<void> {
    const indexNodes = await ctx.entityMemory!.findEntities(INDEX_LABEL);

    let indexNodeId: string;
    if (indexNodes.length === 0) {
      const { entity } = await ctx.entityMemory!.createEntity({
        type: 'concept',
        label: INDEX_LABEL,
        properties: { category: 'config-meta' },
        source: 'skill:config-store',
      });
      indexNodeId = entity.id;
    } else {
      indexNodeId = indexNodes[0]!.id;
    }

    // Same rule as matchConfigFact: prefer properties.key / properties.namespace.
    // Do NOT match on label alone — a fact corrupted by the old semantic merge
    // can have label='travel_detection' with properties.namespace='travel_detection_v2',
    // and a label-only guard would permanently block re-registering travel_detection.
    const existingFacts = await ctx.entityMemory!.getFacts(indexNodeId);
    const alreadyRegistered = existingFacts.some((f) => {
      const propKey = f.properties.key as string | undefined;
      if (typeof propKey === 'string') return propKey === namespace;
      const propNs = f.properties.namespace as string | undefined;
      if (typeof propNs === 'string') return propNs === namespace;
      // True legacy: neither key nor namespace property — label is the only signal.
      return f.properties.key === undefined
        && f.properties.namespace === undefined
        && f.label === namespace;
    });
    if (alreadyRegistered) {
      ctx.log.debug({ namespace }, 'Namespace already in meta-index — skipping duplicate registration');
      return;
    }

    await ctx.entityMemory!.storeFact({
      entityNodeId: indexNodeId,
      label: namespace,
      // key mirrors namespace so exactKey can upsert; namespace kept for older readers.
      properties: { key: namespace, namespace, exact_key: true },
      confidence: 1.0,
      decayClass: 'permanent',
      source: writeSource,
      exactKey: true,
    });
  }
}

function isSendLevelKey(namespace: string, key: string | undefined): boolean {
  return namespace === SEND_SETTING_NAMESPACE && key === SEND_SETTING_KEY;
}

/** The principal's live mailboxes for the send-level key. A failed list is logged and reported. */
async function liveMailboxes(ctx: ToolContext): Promise<
  | { ok: true; mailboxes: Array<{ id: string; label: string; triageStartAt: Date | null }> }
  | { ok: false; error: string }
> {
  try {
    const list = await ctx.principalMailboxes!.list();
    return { ok: true, mailboxes: list.map((m) => ({ id: m.id, label: m.label, triageStartAt: m.triageStartAt })) };
  } catch (err) {
    ctx.log.error({ errName: err instanceof Error ? err.name : typeof err }, 'config-store: could not list the principal mailboxes for ceo_inbox/sending');
    return { ok: false, error: "Couldn't read the principal's connected mailboxes just now, so the sending level was not stored. Try again shortly." };
  }
}
