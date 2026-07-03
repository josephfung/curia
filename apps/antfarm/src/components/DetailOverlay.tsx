import type { SceneDirective } from '@curia/shared-types';

export type OverlayDetail =
  | { type: 'agent'; agentId: string; directive: SceneDirective | null }
  | { type: 'directive'; directive: SceneDirective };

interface DetailOverlayProps {
  detail: OverlayDetail | null;
  onClose: () => void;
}

function directiveSummary(directive: SceneDirective): string {
  switch (directive.kind) {
    case 'claw.deliver':
      return `Claw delivery → ${directive.agentId} (job ${directive.jobId})`;
    case 'agent.state':
      return `Agent ${directive.agentId} → ${directive.state}`;
    case 'agent.walk':
      return `${directive.agentId} walks to ${directive.targetAgentId}`;
    case 'agent.speak':
      return `${directive.agentId} speaks${directive.content ? `: ${directive.content}` : ''}`;
    case 'agent.think':
      return `${directive.agentId} ${directive.phase === 'start' ? 'thinking' : 'done thinking'}${directive.skillName ? ` (${directive.skillName})` : ''}`;
    case 'tube.in':
      return `Inbound tube${directive.conversationId ? ` (${directive.conversationId})` : ''}`;
    case 'tube.out':
      return `Outbound tube${directive.agentId ? ` via ${directive.agentId}` : ''}`;
    case 'task.appear':
      return `Task appeared: ${directive.title ?? directive.taskId}`;
    case 'task.trash':
      return `Task completed: ${directive.taskId}`;
    case 'badge':
      return `${directive.badgeKind}: ${directive.label}`;
    default:
      return 'Unknown directive';
  }
}

export function DetailOverlay({ detail, onClose }: DetailOverlayProps) {
  if (!detail) return null;

  const title =
    detail.type === 'agent'
      ? `Agent: ${detail.agentId}`
      : directiveSummary(detail.directive);

  const payload =
    detail.type === 'directive'
      ? detail.directive
      : detail.directive;

  return (
    <div className="overlay-backdrop" role="dialog" aria-modal="true">
      <div className="overlay-panel">
        <header className="overlay-header">
          <h2>{title}</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="overlay-body">
          {payload && (
            <pre className="overlay-json">{JSON.stringify(payload, null, 2)}</pre>
          )}
          {detail.type === 'agent' && !payload && (
            <p>No active directive for this agent.</p>
          )}
          {payload?.causedBy && (
            <p className="overlay-causal">
              Caused by audit event: <code>{payload.causedBy}</code>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
