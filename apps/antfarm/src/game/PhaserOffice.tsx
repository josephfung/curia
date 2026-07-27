import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { SceneDirective } from '@curia/shared-types';
import type { DeskSlot } from '../layout/desk-layout.js';
import { deskLayoutKey } from '../layout/desk-layout.js';
import { applyDeskLayoutSync, type DeskSyncState } from '../layout/desk-layout-sync.js';
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
  const deskSyncRef = useRef<DeskSyncState>({ lastKey: '' });
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
    // Callbacks go in the registry (like desks) so the scene can read them from init() on EVERY
    // boot/restart. Passing them only via scene.start data loses them across the config auto-start
    // and the restarts in updateLayout/resyncPlayback, leaving this.callbacks undefined — the
    // pointer handlers then throw and no detail overlay opens.
    game.registry.set('desks', desksRef.current);
    game.registry.set('callbacks', callbacks);

    game.events.once('ready', () => {
      const bootDesks = desksRef.current;
      game.scene.start('OfficeScene', { desks: bootDesks, callbacks });
      // Record the boot roster as already applied so a flush of the same key
      // does not call updateLayout → scene.restart() for no reason.
      deskSyncRef.current.lastKey = deskLayoutKey(bootDesks);
    });

    return () => {
      game.destroy(true);
      gameRef.current = null;
      lastFiredRef.current = -1;
      deskSyncRef.current = { lastKey: '' };
    };
  }, []);

  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;

    let cancelled = false;

    const trySync = (): boolean => {
      if (cancelled) return true;
      const result = applyDeskLayoutSync(
        deskSyncRef.current,
        desks,
        game.scene.isActive('OfficeScene'),
        (next) => {
          const scene = game.scene.getScene('OfficeScene') as OfficeScene;
          scene.updateLayout(next);
        },
      );
      return result !== 'waiting';
    };

    if (trySync()) return;

    // Roster arrived mid-boot: retry on scene wake + rAF until active so the
    // update is not dropped when React's effect does not re-fire (#1549).
    const scene = game.scene.getScene('OfficeScene') as OfficeScene | undefined;
    const onAwake = () => {
      trySync();
    };
    scene?.events.on('start', onAwake);
    scene?.events.on('ready', onAwake);
    scene?.events.on('wake', onAwake);

    let raf = 0;
    const poll = () => {
      if (trySync()) return;
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      scene?.events.off('start', onAwake);
      scene?.events.off('ready', onAwake);
      scene?.events.off('wake', onAwake);
    };
  }, [desks]);

  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;

    const scene = game.scene.getScene('OfficeScene') as OfficeScene | undefined;
    if (!scene?.scene.isActive()) return;

    if (firedIndex < lastFiredRef.current) {
      const replay = schedule.slice(0, firedIndex + 1).map((entry) => entry.directive);
      scene.resyncPlayback(replay, desksRef.current);
      lastFiredRef.current = firedIndex;
      return;
    }

    if (firedIndex <= lastFiredRef.current) return;

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
