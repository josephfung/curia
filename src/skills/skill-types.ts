// skill-types.ts — types for the skill (bundle) layer.
//
// A skill is a collection of tools + optional instructions — the install / pin /
// discover / activate unit (ADR-031, design 2026-07-16). Tools remain the
// invocation + authorization atoms; skills never flatten per-tool action_risk.

/** Parsed SKILL.md frontmatter + body. */
export interface SkillManifest {
  /** Skill name (bundle id). Lowercase letters, numbers, hyphens. */
  name: string;
  /** Discovery / pin description. */
  description: string;
  /** Semver for native skills; optional for imported Anthropic skills. */
  version?: string;
  /**
   * Member tool names. When omitted at parse time, the loader fills this from
   * the skill's `tools/` subdirectories (manifest.name of each tool.json).
   * Imported Anthropic skills (NL + assets) typically have an empty list.
   */
  tools: string[];
  /** Markdown body after frontmatter — injected into the agent prompt when pinned. */
  instructions: string;
  /**
   * Relative paths under `references/` (progressive disclosure, Phase 3).
   * Listed at activation; loaded on demand via skill-activate `reference`.
   */
  references?: string[];
  /**
   * Relative paths under `assets/` (templates / static files, Phase 3).
   * Same on-demand read path as references.
   */
  assets?: string[];
  /**
   * True when a `scripts/` directory is present. Scripts are never executed in
   * Phase 3 — import emits a warning and leaves them inert until Phase 4.
   */
  hasScripts?: boolean;
  /**
   * When true, agents that pin this skill are heartbeat-eligible (BacklogHeartbeat
   * may wake them for ready tasks). Replaces `enable_task_management`.
   */
  heartbeat?: boolean;
  /**
   * When true, agents that pin this skill get the document-workspace runtime
   * surface (`documentWorkspaceEnabled` + workingDocs). `taskRepo` is wired when
   * either this flag or `heartbeat` is set (tasks and documents both need it).
   */
  document_workspace?: boolean;
}

/** A skill registered in the in-memory SkillRegistry. */
export interface RegisteredSkill {
  manifest: SkillManifest;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
  /**
   * True when this skill was synthesized as a singleton wrapper around a lone
   * tool that has no owning SKILL.md bundle yet (transitional flat layout).
   */
  synthetic?: boolean;
}

/** One discovered on-disk skill (lenient parse for registry UI + reconciliation). */
export interface SkillDiscovery {
  name: string;
  metadata: {
    name: string;
    description: string;
    version: string;
    tools: string[];
    heartbeat?: boolean;
    documentWorkspace?: boolean;
    /** Present when references/ or assets/ were discovered (imported NL+asset skills). */
    references?: string[];
    assets?: string[];
    hasScripts?: boolean;
  } | null;
  error?: string;
  dir: string;
  /** Full parsed manifest when metadata !== null. */
  manifest?: SkillManifest;
}
