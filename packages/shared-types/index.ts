/** Shared Ant Farm contract — dependency-free types for producer and consumer. */

export interface SceneDirectiveBase {
  /** Source audit_log row id (dedupe key). */
  id: string;
  /** Logical time in epoch milliseconds. */
  logicalTs: number;
  /** Causal parent audit row id, when present. */
  causedBy: string | null;
}

export interface ClawDeliverDirective extends SceneDirectiveBase {
  kind: 'claw.deliver';
  jobId: string;
  agentId: string;
  taskId?: string | null;
}

export interface AgentStateDirective extends SceneDirectiveBase {
  kind: 'agent.state';
  agentId: string;
  state: 'active' | 'error';
}

export interface AgentWalkDirective extends SceneDirectiveBase {
  kind: 'agent.walk';
  agentId: string;
  targetAgentId: string;
}

export interface AgentSpeakDirective extends SceneDirectiveBase {
  kind: 'agent.speak';
  agentId: string;
  threadId?: string;
  content?: string;
}

export interface AgentThinkDirective extends SceneDirectiveBase {
  kind: 'agent.think';
  agentId: string;
  phase: 'start' | 'stop';
  toolName?: string;
}

export interface TubeInDirective extends SceneDirectiveBase {
  kind: 'tube.in';
  conversationId?: string;
  channelId?: string;
}

export interface TubeOutDirective extends SceneDirectiveBase {
  kind: 'tube.out';
  conversationId?: string;
  agentId?: string;
}

export interface TaskAppearDirective extends SceneDirectiveBase {
  kind: 'task.appear';
  taskId: string;
  title?: string;
}

export interface TaskTrashDirective extends SceneDirectiveBase {
  kind: 'task.trash';
  taskId: string;
}

export interface BadgeDirective extends SceneDirectiveBase {
  kind: 'badge';
  badgeKind: 'human.decision' | 'autonomy.blocked' | 'authorization.decision';
  label: string;
}

export type SceneDirective =
  | ClawDeliverDirective
  | AgentStateDirective
  | AgentWalkDirective
  | AgentSpeakDirective
  | AgentThinkDirective
  | TubeInDirective
  | TubeOutDirective
  | TaskAppearDirective
  | TaskTrashDirective
  | BadgeDirective;

export interface ActivityScript {
  directives: SceneDirective[];
}

/** Minimal audit row shape consumed by the interpreter (no backend imports). */
export interface AuditEventRow {
  id: string;
  timestamp: Date | string;
  eventType: string;
  sourceLayer: string;
  sourceId: string;
  conversationId: string | null;
  parentEventId: string | null;
  payload: Record<string, unknown>;
  /** Structured action (Phase 1) — optional; null/absent on pre-hardening rows. */
  action?: string | null;
  /** Structured initiator id (Phase 1) — optional; null/absent on pre-hardening rows. */
  initiatorId?: string | null;
}

/** SSE envelope for live Ant Farm directive streaming. */
export interface AntFarmSseEnvelope {
  type: 'directive' | 'heartbeat';
  directive?: SceneDirective;
  ts?: string;
}
