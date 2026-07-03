import { useCallback, useEffect, useRef, useState } from 'react';
import type { AntFarmSseEnvelope, SceneDirective } from '@curia/shared-types';

export interface LiveStreamState {
  connected: boolean;
  streamOpenTs: number | null;
  buffer: SceneDirective[];
  error: string | null;
}

export function useLiveStream(enabled: boolean) {
  const [state, setState] = useState<LiveStreamState>({
    connected: false,
    streamOpenTs: null,
    buffer: [],
    error: null,
  });
  const sourceRef = useRef<EventSource | null>(null);

  const clearBuffer = useCallback(() => {
    setState((prev) => ({ ...prev, buffer: [] }));
  }, []);

  useEffect(() => {
    if (!enabled) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setState({ connected: false, streamOpenTs: null, buffer: [], error: null });
      return;
    }

    const openTs = Date.now();
    const source = new EventSource('/api/antfarm/stream', { withCredentials: true });
    sourceRef.current = source;

    setState({ connected: false, streamOpenTs: openTs, buffer: [], error: null });

    source.onopen = () => {
      setState((prev) => ({ ...prev, connected: true, error: null }));
    };

    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as AntFarmSseEnvelope;
        if (envelope.type !== 'directive' || !envelope.directive) return;
        setState((prev) => ({
          ...prev,
          buffer: [...prev.buffer, envelope.directive!],
        }));
      } catch {
        // Ignore malformed frames (heartbeats use comment lines, not message events).
      }
    };

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setState((prev) => ({
          ...prev,
          connected: false,
          error: 'Live stream disconnected',
        }));
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [enabled]);

  return { ...state, clearBuffer };
}
