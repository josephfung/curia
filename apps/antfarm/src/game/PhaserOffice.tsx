import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { SceneDirective } from '@curia/shared-types';
import type { DeskSlot } from '../layout/desk-layout.js';
import type { ScheduledDirective } from '../conductor/types.js';
import { OfficeScene, type OfficeSceneCallbacks } from './OfficeScene.js';
import { STAGE_HEIGHT, STAGE_WIDTH } from './world-layout.js';

export interface PhaserOfficeProps {
  desks: DeskSlot[];
  schedule: ScheduledDirective[];
  firedIndex: number;
  onAgentClick: (agentId: string, directive: SceneDirective | null) => void;
  onDirectiveClick: (directive: SceneDirective) => void;
}

export function PhaserOffice({
  desks,
  schedule,
  firedIndex,
  onAgentClick,
  onDirectiveClick,
}: PhaserOfficeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const lastFiredRef = useRef(-1);
  const callbacksRef = useRef<OfficeSceneCallbacks>({ onAgentClick, onDirectiveClick });
  const desksRef = useRef(desks);

  callbacksRef.current = { onAgentClick, onDirectiveClick };
  desksRef.current = desks;

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const callbacks: OfficeSceneCallbacks = {
      onAgentClick: (id, d) => callbacksRef.current.onAgentClick(id, d),
      onDirectiveClick: (d) => callbacksRef.current.onDirectiveClick(d),
    };

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      parent: containerRef.current,
      backgroundColor: '#1a1f16',
      pixelArt: true,
      scene: OfficeScene,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    gameRef.current = game;
    game.registry.set('desks', desksRef.current);

    game.events.once('ready', () => {
      game.scene.start('OfficeScene', { desks: desksRef.current, callbacks });
    });

    return () => {
      game.destroy(true);
      gameRef.current = null;
      lastFiredRef.current = -1;
    };
  }, []);

  useEffect(() => {
    const game = gameRef.current;
    if (!game?.scene.isActive('OfficeScene')) return;
    const scene = game.scene.getScene('OfficeScene') as OfficeScene;
    scene.updateLayout(desks);
  }, [desks]);

  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;

    if (firedIndex < lastFiredRef.current) {
      lastFiredRef.current = firedIndex;
    }
    if (firedIndex <= lastFiredRef.current) return;

    const scene = game.scene.getScene('OfficeScene') as OfficeScene | undefined;
    if (!scene?.scene.isActive()) return;

    for (let i = lastFiredRef.current + 1; i <= firedIndex; i++) {
      const entry = schedule[i];
      if (entry) {
        scene.playDirective(entry.directive);
      }
    }
    lastFiredRef.current = firedIndex;
  }, [firedIndex, schedule]);

  return (
    <div className="phaser-office">
      <div ref={containerRef} className="phaser-canvas-host" />
    </div>
  );
}
