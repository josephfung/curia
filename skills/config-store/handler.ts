// skills/config-store/handler.ts
//
// Generic key-value configuration store backed by the knowledge graph.
//
// KG storage model:
//   Namespace anchor: type=concept, label="config:{namespace}"
//     properties: { category: 'config', namespace }
//   Per-key facts on the anchor:
//     label=key, properties: { key, value, namespace }, decayClass=permanent
//   Meta-index anchor: type=concept, label="config-store-index"
//     Per-namespace facts: label=namespace, properties: { namespace }, decayClass=permanent
//
// The meta-index lets list_namespaces run as a single KG read rather than a
// label-scan across all entities.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const INDEX_LABEL = 'config-store-index';

function anchorLabel(namespace: string): string {
  return `config:${namespace}`;
}

export class ConfigStoreHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve', 'list_namespaces'].includes(action)) {
      return {
        success: false,
        error: "Missing or invalid 'action' — must be 'store', 'retrieve', or 'list_namespaces'",
      };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot access config store' };
    }

    if (action === 'store') return this.store(ctx);
    if (action === 'retrieve') return this.retrieve(ctx);
    return this.listNamespaces(ctx);
  }

  private async store(ctx: SkillContext): Promise<SkillResult> {
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
    if (!value || typeof value !== 'string') {
      return { success: false, error: 'Missing required input: value' };
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

    try {
      const anchor = await this.findOrCreateAnchor(ctx, namespace);

      await ctx.entityMemory!.storeFact({
        entityNodeId: anchor.id,
        label: key,
        properties: { key, value, namespace },
        confidence: 1.0,
        // Config values are permanent — stable URLs / IDs the CEO provides once
        decayClass: 'permanent',
        source: 'skill:config-store',
      });

      // Register the namespace in the meta-index so list_namespaces can find it
      await this.registerNamespace(ctx, namespace);

      ctx.log.info({ namespace, key }, 'Stored config value');
      return { success: true, data: { stored: true, namespace, key } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, namespace, key }, 'Failed to store config value');
      return { success: false, error: `Failed to store: ${message}` };
    }
  }

  private async retrieve(ctx: SkillContext): Promise<SkillResult> {
    const { namespace, key } = ctx.input as { namespace?: string; key?: string };

    if (!namespace || typeof namespace !== 'string') {
      return { success: false, error: 'Missing required input: namespace' };
    }

    try {
      const anchors = await ctx.entityMemory!.findEntities(anchorLabel(namespace));

      if (anchors.length === 0) {
        // Namespace has never been written to
        if (key) {
          return { success: true, data: { found: false, key } };
        }
        return {
          success: true,
          data: {
            entries: [],
            message: `No config stored in namespace '${namespace}' yet.`,
          },
        };
      }

      // Collect facts across all anchor nodes for this namespace. Multiple anchors
      // can exist if findOrCreateAnchor races (same pattern as knowledge-company-overview).
      const allFacts = await Promise.all(anchors.map((a) => ctx.entityMemory!.getFacts(a.id)));
      const facts = allFacts.flat();

      if (key) {
        const fact = facts.find((f) => f.label === key);
        if (!fact) {
          return { success: true, data: { found: false, key } };
        }
        ctx.log.info({ namespace, key }, 'Retrieved config value');
        return {
          success: true,
          data: {
            found: true,
            key,
            value: fact.properties.value as string,
          },
        };
      }

      const entries = facts.map((f) => ({
        // Fall back to label if properties.key is absent (forward-compat for hand-crafted nodes)
        key: (f.properties.key as string | undefined) ?? f.label,
        value: f.properties.value as string,
      }));

      ctx.log.info({ namespace, entryCount: entries.length }, 'Retrieved config entries');
      return { success: true, data: { entries } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, namespace }, 'Failed to retrieve config');
      return { success: false, error: `Failed to retrieve: ${message}` };
    }
  }

  private async listNamespaces(ctx: SkillContext): Promise<SkillResult> {
    try {
      const indexNodes = await ctx.entityMemory!.findEntities(INDEX_LABEL);

      if (indexNodes.length === 0) {
        return { success: true, data: { namespaces: [] } };
      }

      const allFacts = await Promise.all(indexNodes.map((n) => ctx.entityMemory!.getFacts(n.id)));
      const namespaces = allFacts.flat().map(
        (f) => (f.properties.namespace as string | undefined) ?? f.label,
      );

      ctx.log.info({ namespaceCount: namespaces.length }, 'Listed config namespaces');
      return { success: true, data: { namespaces } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to list namespaces');
      return { success: false, error: `Failed to list namespaces: ${message}` };
    }
  }

  private async findOrCreateAnchor(ctx: SkillContext, namespace: string) {
    const label = anchorLabel(namespace);
    const existing = await ctx.entityMemory!.findEntities(label);
    if (existing.length > 0) return existing[0]!;

    const { entity } = await ctx.entityMemory!.createEntity({
      type: 'concept',
      label,
      properties: { category: 'config', namespace },
      source: 'skill:config-store',
    });
    return entity;
  }

  private async registerNamespace(ctx: SkillContext, namespace: string): Promise<void> {
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

    await ctx.entityMemory!.storeFact({
      entityNodeId: indexNodeId,
      label: namespace,
      properties: { namespace },
      confidence: 1.0,
      decayClass: 'permanent',
      source: 'skill:config-store',
    });
  }
}
