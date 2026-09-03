// registry-service.ts — merges on-disk manifest discovery with registry rows to
// compute derived state, and exposes the install/enable/disable/uninstall lifecycle
// the /api/registry routes call. State changes touch the DB only; the live in-memory
// ToolRegistry / SkillRegistry / AgentRegistry are NOT mutated — enforcement is
// restart-based (spec §6 / ADR-022).
//
// Kinds: tool (atom), skill (bundle), agent.

import type {
  IRegistryRepo, RegistryKind, RegistryEntry, Discovery, SecretsLister, IBundleCascadeRepo,
} from './types.js';
import { RegistryGuardError } from './types.js';

export class RegistryService {
  // Discovery is captured once at startup and held here. setDiscovery exists so the
  // bootstrap (and tests) can inject the lenient discovery results after construction.
  //
  // `secrets` (optional) backs the PR2 install/enable gate: a tool that declares
  // install.requires_secrets cannot go live until those keys exist in the vault. It is
  // optional so non-secrets call sites (and most tests) construct the service unchanged;
  // when a tool DOES require secrets but no lister is wired, the gate fails closed.
  constructor(
    private readonly toolRepo: IRegistryRepo,
    private readonly agentRepo: IRegistryRepo,
    private toolDiscovery: Discovery[],
    private agentDiscovery: Discovery[],
    private readonly secrets?: SecretsLister,
    private readonly skillRepo?: IRegistryRepo,
    private skillDiscovery: Discovery[] = [],
    // Cross-table cascade for bundle enable/disable. Required for kind='skill';
    // absent is a wiring error, not a fallback (see bundleTools()).
    private readonly cascade?: IBundleCascadeRepo,
  ) {}

  setDiscovery(kind: RegistryKind, discovery: Discovery[]): void {
    if (kind === 'tool') this.toolDiscovery = discovery;
    else if (kind === 'agent') this.agentDiscovery = discovery;
    else this.skillDiscovery = discovery;
  }

  private repo(kind: RegistryKind): IRegistryRepo {
    if (kind === 'tool') return this.toolRepo;
    if (kind === 'agent') return this.agentRepo;
    if (!this.skillRepo) {
      throw new Error('RegistryService: skill_registry repo not configured');
    }
    return this.skillRepo;
  }

  private discovery(kind: RegistryKind): Discovery[] {
    if (kind === 'tool') return this.toolDiscovery;
    if (kind === 'agent') return this.agentDiscovery;
    return this.skillDiscovery;
  }

  /** Member tools of a bundle, from on-disk discovery.
   *
   *  Returns `null` when the member list CANNOT be determined — no discovery entry at all
   *  (a ghost bundle) or `metadata === null` because the manifest failed to parse. That is
   *  emphatically NOT the same as a manifest that parsed and legitimately lists no tools,
   *  which returns `[]`.
   *
   *  The distinction is load-bearing (finding #2). A tool's runtime availability is gated
   *  ONLY by `tool_registry.enabled` — src/index.ts builds the enabled-tool set purely from
   *  `tool_registry` with no join to `skill_registry`, and tools are loaded before
   *  SkillRegistry is even populated. So cascading `[]` because we could not read the member
   *  list would flip only the `skill_registry` row while every member tool_registry row
   *  stayed enabled: the tools remain live and callable, and the operator is told the
   *  disable succeeded. Callers must therefore treat `null` as "refuse", never as "nothing
   *  to do". */
  private bundleTools(name: string): string[] | null {
    const disc = this.skillDiscovery.find(d => d.name === name);
    if (!disc || disc.metadata === null) return null;
    return disc.metadata.tools ?? [];
  }

  /** bundleTools() for callers that have already passed assertInstallable — which
   *  guarantees a discovery entry with parsed metadata, hence a determinable member list.
   *  The throw is a defensive invariant check, not an expected operator-facing rejection. */
  private requireBundleTools(name: string): string[] {
    const tools = this.bundleTools(name);
    if (tools === null) {
      throw new RegistryGuardError(
        `Cannot determine the member tools of bundle '${name}': its manifest is missing or ` +
        `failed to parse. Repair the manifest before enabling the bundle.`,
      );
    }
    return tools;
  }

  private requireCascade(name: string): IBundleCascadeRepo {
    if (!this.cascade) {
      throw new Error(
        `RegistryService: bundle cascade repo not configured; refusing to change '${name}' ` +
        `without cascading its member tools`,
      );
    }
    return this.cascade;
  }

  /** Every known item (on disk and/or in DB) with its derived state. */
  async list(kind: RegistryKind): Promise<RegistryEntry[]> {
    const rows = await this.repo(kind).listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const discovery = this.discovery(kind);
    const discByName = new Map(discovery.map(d => [d.name, d]));

    const names = new Set<string>([...discByName.keys(), ...rowByName.keys()]);
    const entries: RegistryEntry[] = [];

    for (const name of names) {
      const disc = discByName.get(name);
      const row = rowByName.get(name);
      const onDisk = disc !== undefined;

      let state: RegistryEntry['state'];
      if (!onDisk) state = 'ghost';
      else if (!row) state = 'uninstalled';
      else state = row.enabled ? 'enabled' : 'installed';

      entries.push({
        name,
        kind,
        state,
        metadata: disc?.metadata ?? null,
        manifestError: disc?.error,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }

    // Stable alphabetical order for a predictable UI.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Every vault key declared across tools' install.requires_secrets (deduped).
   *  Scopes the vault write endpoint: only a secret some tool actually needs may be set
   *  through it, so the console can't write arbitrary keys into the vault. Reads from
   *  in-memory discovery — no DB round-trip.
   *  Tools only by design (agents/skills don't declare requires_secrets); if that ever
   *  changes, this must also union those discoveries. */
  declaredSecretNames(): string[] {
    const names = new Set<string>();
    for (const d of this.toolDiscovery) {
      for (const s of d.metadata?.requiresSecrets ?? []) names.add(s);
    }
    return [...names];
  }

  /** Look up a single derived entry (used to return the post-op state). */
  private async entry(kind: RegistryKind, name: string): Promise<RegistryEntry> {
    const all = await this.list(kind);
    const found = all.find(e => e.name === name);
    if (!found) throw new Error(`Registry entry '${name}' not found after operation`);
    return found;
  }

  /** Reject installing/enabling something that isn't a healthy on-disk manifest. */
  private assertInstallable(kind: RegistryKind, name: string): void {
    const disc = this.discovery(kind).find(d => d.name === name);
    if (!disc) {
      throw new RegistryGuardError(`Cannot install '${name}': not on disk (no manifest found).`);
    }
    if (disc.metadata === null) {
      throw new RegistryGuardError(`Cannot install '${name}': its manifest failed to parse (${disc.error ?? 'unknown error'}).`);
    }
  }

  /** PR2 (#939) secrets gate: reject install/enable when the item's manifest declares
   *  install.requires_secrets that aren't all present in the vault. Items with no declared
   *  secrets are unaffected. A declared-but-unverifiable secret (no lister wired) fails
   *  closed — we never let something requiring secrets go live without confirming them.
   *
   *  A bundle skill declares no requires_secrets of its own — its member tools do — so the
   *  bundle path delegates to assertBundleSecretsConfigured, which gates on the union of the
   *  members' declarations. Returning early for kind='skill' (as this used to) let an
   *  operator bypass the gate entirely: enabling `web-search` directly was refused when its
   *  key was absent, but enabling the `web` bundle wrote the same tool_registry row through
   *  the cascade and the tool went live at the next restart with no credential (finding #1). */
  private async assertSecretsConfigured(kind: RegistryKind, name: string): Promise<void> {
    if (kind === 'skill') {
      await this.assertBundleSecretsConfigured(name);
      return;
    }
    const disc = this.discovery(kind).find(d => d.name === name);
    const required = disc?.metadata?.requiresSecrets ?? [];
    if (required.length === 0) return;

    if (!this.secrets) {
      throw new RegistryGuardError(
        `Cannot install '${name}': it requires secrets (${required.join(', ')}) but the secrets vault is unavailable.`,
      );
    }
    const configured = new Set(await this.secrets.list());
    const missing = required.filter(s => !configured.has(s));
    if (missing.length > 0) {
      throw new RegistryGuardError(
        `Cannot install '${name}': required secret(s) not configured in the vault: ${missing.join(', ')}. ` +
        `Configure them before installing.`,
      );
    }
  }

  /** Bundle arm of the secrets gate (finding #1). Enabling a bundle writes its member
   *  tool_registry rows through the cascade — the very rows that make a tool live — so the
   *  bundle must clear the same vault check the member tools would have enforced had they
   *  been enabled one at a time.
   *
   *  We track WHICH member declared each key, not just the key set, because an operator
   *  staring at "bundle web needs tavily_api_key" has to know it is `web-search` asking, so
   *  they can decide whether to supply the credential or drop the member.
   *
   *  A member with no discovery entry (or an unparsable manifest) contributes nothing here:
   *  its own per-tool gate still runs whenever it is enabled directly, and a tool whose
   *  manifest cannot be read never loads at runtime anyway, so it cannot go live without a
   *  credential. Failing closed on such members would instead block bundles whose members
   *  simply are not in the tool discovery set (e.g. under test or partial discovery). */
  private async assertBundleSecretsConfigured(bundle: string): Promise<void> {
    // Same member list the cascade will write, so the gate can never cover a different set
    // of tools than the operation itself touches.
    const members = this.requireBundleTools(bundle);

    // secret key → member tools that declare it (deduped by construction).
    const requiredBy = new Map<string, string[]>();
    for (const member of members) {
      const memberDisc = this.toolDiscovery.find(d => d.name === member);
      for (const secret of memberDisc?.metadata?.requiresSecrets ?? []) {
        const declarers = requiredBy.get(secret) ?? [];
        declarers.push(member);
        requiredBy.set(secret, declarers);
      }
    }
    if (requiredBy.size === 0) return;

    const required = [...requiredBy.keys()];
    // Renders "key (required by tool-a, tool-b)" so the message names the credential AND
    // the member that needs it.
    const describe = (keys: string[]): string =>
      keys.map(k => `${k} (required by ${requiredBy.get(k)!.join(', ')})`).join('; ');

    if (!this.secrets) {
      // Fail closed, exactly as the per-tool path does: unverifiable is not the same as fine.
      throw new RegistryGuardError(
        `Cannot enable bundle '${bundle}': its member tools require secrets ` +
        `(${describe(required)}) but the secrets vault is unavailable.`,
      );
    }
    const configured = new Set(await this.secrets.list());
    const missing = required.filter(s => !configured.has(s));
    if (missing.length > 0) {
      throw new RegistryGuardError(
        `Cannot enable bundle '${bundle}': required secret(s) not configured in the vault: ` +
        `${describe(missing)}. Configure them before enabling the bundle.`,
      );
    }
  }

  async install(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.assertSecretsConfigured(kind, name);
    await this.repo(kind).install(name, actor);
    return this.entry(kind, name);
  }

  async enable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    // Re-check at enable time too: secrets could have been deleted since install, and
    // enable is the moment the item actually goes live on the next restart.
    await this.assertSecretsConfigured(kind, name);
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new RegistryGuardError(`Cannot enable '${name}': not installed. Install it first.`);
    if (kind === 'skill') {
      // Bundle + members in one transaction — the bundle is the unit of control (#1724).
      // requireBundleTools (not bundleTools) because assertInstallable above has already
      // proven the manifest parsed, so the member list must be determinable here.
      await this.requireCascade(name).enableBundle(name, this.requireBundleTools(name), actor);
    } else {
      await this.repo(kind).enable(name, actor);
    }
    return this.entry(kind, name);
  }

  async installAndEnable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.assertSecretsConfigured(kind, name);
    if (kind === 'skill') {
      // No separate install() here: ENABLE_SKILL (bundle-cascade-repo.ts) is already an
      // upsert (`INSERT ... ON CONFLICT DO UPDATE`), so the cascade alone installs-and-
      // enables the bundle + its member tools in one transaction. Pre-installing via
      // repo(kind).install() would commit outside that transaction — if the cascade then
      // failed, the bundle would be left installed with zero member tools touched, the
      // exact partial state this feature exists to prevent (finding #4).
      await this.requireCascade(name).enableBundle(name, this.requireBundleTools(name), actor);
    } else {
      await this.repo(kind).install(name, actor);
      await this.repo(kind).enable(name, actor);
    }
    return this.entry(kind, name);
  }

  async disable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new RegistryGuardError(`Cannot disable '${name}': no registry row.`);
    if (kind === 'skill') {
      // Deliberately NOT assertInstallable: disabling a bundle whose manifest is merely
      // broken is a legitimate thing to want to do — it is often exactly why the operator
      // is here. What we must refuse is a disable whose cascade would be INCOMPLETE.
      //
      // bundleTools() returns null when the member list cannot be read (ghost bundle, or a
      // manifest that failed to parse). Cascading `[]` there would flip only the
      // skill_registry row while every member tool_registry row stayed enabled — and since
      // runtime availability is gated on tool_registry alone, those tools would stay live
      // and callable while the console reported success. Re-enabling is blocked by
      // assertInstallable, so there would be no bundle-level route back to a consistent
      // state either. Fail loudly and tell the operator the two ways out (finding #2).
      const tools = this.bundleTools(name);
      if (tools === null) {
        throw new RegistryGuardError(
          `Cannot disable bundle '${name}': its member tool list cannot be read (no manifest ` +
          `on disk, or the manifest failed to parse), so the cascade would leave its member ` +
          `tools enabled and still callable. Disable the member tools individually, or repair ` +
          `the bundle's manifest and try again.`,
        );
      }
      // A manifest that parsed and lists zero tools reaches here with `[]` — cascading
      // nothing is correct in that case, and the bundle row still flips.
      await this.requireCascade(name).disableBundle(name, tools, actor);
    } else {
      await this.repo(kind).disable(name, actor);
    }
    return this.entry(kind, name);
  }

  /** Uninstall is allowed even for ghosts — it's the only way to clear a ghost row.
   *  Rejects an ENABLED bundle whose members are known (finding #3 — see inline), and
   *  rejects when nothing was actually deleted: a DELETE that matches zero rows (e.g.
   *  the bundle-routing bug that sent `DELETE /skills/ceo-inbox` to the tools table)
   *  must not report success while leaving the item in place (finding #2). */
  async uninstall(kind: RegistryKind, name: string, _actor: string): Promise<void> {
    if (kind === 'skill') {
      // Finding #3: uninstall deletes the skill_registry row only — it never routes through
      // the cascade. Uninstalling an ENABLED bundle therefore removed the row that owns the
      // members while leaving every member tool_registry row enabled = true; after a restart
      // those tools still load (runtime gating reads tool_registry alone) and stay callable
      // by any agent, with no bundle owning them. The console offers Uninstall in the
      // 'enabled' state, so this is one misclick away.
      //
      // Refuse, and point at disable — which DOES cascade — as the way to get there. We do
      // not silently disable-then-uninstall on the operator's behalf: an unrequested cascade
      // that strips 14 tools is not something to do implicitly.
      // The refusal is scoped to bundles whose member list is readable — i.e. exactly the
      // bundles for which "disable first" is a route that actually works. A ghost (no
      // manifest on disk) or a bundle with an unparsable manifest has no cascade route at
      // all: disable() rejects those for the same unreadable-member-list reason, so blocking
      // uninstall too would leave the row with no route out at all, and clearing a ghost row
      // is the only way to remove one. Those fall through to the unconditional delete below.
      if (this.bundleTools(name) !== null) {
        // Conditional delete rather than read-then-delete: checking `enabled` and then
        // DELETEing in two statements leaves a window in which a concurrent enable commits
        // its bundle+member cascade, after which the DELETE strips the owning bundle row and
        // strands its members enabled — the exact orphaning this guard exists to prevent.
        // The predicate rides in the statement, so the check and the delete are atomic.
        const deleted = await this.repo(kind).uninstallIfDisabled(name);
        if (deleted) return;

        // Nothing deleted: either no row, or it is enabled. Re-read only to pick the right
        // message — this read carries no correctness weight, the delete already did that.
        const row = await this.repo(kind).getRow(name);
        if (row?.enabled) {
          throw new RegistryGuardError(
            `Cannot uninstall bundle '${name}' while it is enabled: its member tools would stay ` +
            `enabled and callable with no bundle owning them. Disable the bundle first (that ` +
            `cascades to its member tools), then uninstall it.`,
          );
        }
        throw new RegistryGuardError(`Cannot uninstall ${kind} '${name}': no registry row exists.`);
      }
      // An 'installed' (not enabled) bundle needs no special handling: it has no live members
      // to strand, and the conditional delete above already covers it.
    }
    const deleted = await this.repo(kind).uninstall(name);
    if (!deleted) {
      throw new RegistryGuardError(`Cannot uninstall ${kind} '${name}': no registry row exists.`);
    }
  }
}
