import { useEffect, useMemo, useRef, useState } from 'react';
import type { SceneDirective } from '@curia/shared-types';
import { Conductor } from '../conductor/conductor.js';
import type { ConductorSnapshot } from '../conductor/types.js';

export function useConductor(initialDirectives: SceneDirective[] = []) {
  const conductorRef = useRef<Conductor | null>(null);
  if (!conductorRef.current) {
    conductorRef.current = new Conductor();
    if (initialDirectives.length > 0) {
      conductorRef.current.loadScript({ directives: initialDirectives });
    }
  }

  const [snapshot, setSnapshot] = useState<ConductorSnapshot>(
    () => conductorRef.current!.getSnapshot(),
  );

  useEffect(() => {
    let frame = 0;
    const loop = (now: number) => {
      const fired = conductorRef.current!.tick(now);
      if (fired.length > 0 || conductorRef.current!.getMode() === 'playing') {
        setSnapshot(conductorRef.current!.getSnapshot());
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const api = useMemo(() => ({
    conductor: conductorRef.current!,
    refresh: () => setSnapshot(conductorRef.current!.getSnapshot()),
  }), []);

  return { snapshot, ...api };
}
