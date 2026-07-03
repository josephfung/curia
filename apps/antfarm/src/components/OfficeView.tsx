import type { SceneDirective } from '@curia/shared-types';
import type { DeskSlot } from '../layout/desk-layout.js';

interface OfficeViewProps {
  desks: DeskSlot[];
  activeDirective: SceneDirective | null;
  firedCount: number;
}

function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 45% 45%)`;
}

export function OfficeView({ desks, activeDirective, firedCount }: OfficeViewProps) {
  const boss = desks.filter((d) => d.row === 'boss');
  const floor = desks.filter((d) => d.row === 'floor');

  return (
    <div className="office">
      <div className="office-grid boss-row">
        {boss.map((desk) => (
          <DeskBlock
            key={desk.agentId}
            desk={desk}
            highlighted={isDirectiveForAgent(activeDirective, desk.agentId)}
          />
        ))}
      </div>
      <div className="office-grid floor-row">
        {floor.map((desk) => (
          <DeskBlock
            key={desk.agentId}
            desk={desk}
            highlighted={isDirectiveForAgent(activeDirective, desk.agentId)}
          />
        ))}
      </div>
      <div className="office-meta">
        <span>{firedCount} beats played</span>
        {activeDirective && (
          <span className="active-beat">{activeDirective.kind}</span>
        )}
      </div>
    </div>
  );
}

function DeskBlock({ desk, highlighted }: { desk: DeskSlot; highlighted: boolean }) {
  return (
    <div
      className={`desk ${desk.row} ${highlighted ? 'active' : ''}`}
      style={{ borderColor: agentColor(desk.agentId) }}
    >
      <div className="desk-avatar" style={{ background: agentColor(desk.agentId) }} />
      <div className="desk-label">{desk.agentId}</div>
    </div>
  );
}

function isDirectiveForAgent(directive: SceneDirective | null, agentId: string): boolean {
  if (!directive) return false;
  if ('agentId' in directive && directive.agentId === agentId) return true;
  if (directive.kind === 'agent.walk' && directive.targetAgentId === agentId) return true;
  return false;
}
