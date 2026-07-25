import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteTrack } from 'livekit-client';
import { apiFetch } from '../../api.js';

export type VoiceCallState = 'idle' | 'connecting' | 'connected' | 'error';

interface VoiceStatusResponse {
  enabled: boolean;
}

interface VoiceSessionResponse {
  sessionId: string;
  conversationId: string;
  livekitUrl: string;
  token: string;
  roomName: string;
}

export interface UseVoiceCallResult {
  voiceAvailable: boolean;
  callState: VoiceCallState;
  muted: boolean;
  error: string | null;
  sessionId: string | null;
  startCall: () => Promise<void>;
  toggleMute: () => Promise<void>;
  hangUp: () => Promise<void>;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function voiceErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'Microphone permission was blocked. Allow microphone access and try again.';
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return 'No microphone was found. Connect a microphone and try again.';
    }
  }
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return 'Could not start the voice call.';
}

function removeElement(element: HTMLMediaElement) {
  element.pause();
  element.removeAttribute('src');
  element.srcObject = null;
  element.load();
  element.parentNode?.removeChild(element);
}

export function useVoiceCall(): UseVoiceCallResult {
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [callState, setCallState] = useState<VoiceCallState>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const roomRef = useRef<Room | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const audioElementsRef = useRef<HTMLMediaElement[]>([]);
  const startAbortRef = useRef<AbortController | null>(null);

  const detachAllAudio = useCallback(() => {
    for (const element of audioElementsRef.current) {
      removeElement(element);
    }
    audioElementsRef.current = [];
  }, []);

  const attachRemoteAudio = useCallback((track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;

    const element = track.attach();
    element.autoplay = true;
    element.controls = false;
    element.style.display = 'none';
    document.body.appendChild(element);
    audioElementsRef.current.push(element);
    void element.play().catch(() => {
      if (mountedRef.current) {
        setError('Audio playback was blocked. Use the call controls to reconnect.');
      }
    });
  }, []);

  const detachRemoteAudio = useCallback((track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;

    const detached = track.detach();
    for (const element of detached) {
      audioElementsRef.current = audioElementsRef.current.filter((item) => item !== element);
      removeElement(element);
    }
  }, []);

  const resetLocalCall = useCallback((room?: Room | null) => {
    const activeRoom = room ?? roomRef.current;
    if (roomRef.current === activeRoom) roomRef.current = null;
    if (activeRoom) {
      activeRoom.removeAllListeners();
      activeRoom.disconnect();
    }
    sessionIdRef.current = null;
    detachAllAudio();
    if (mountedRef.current) {
      setSessionId(null);
      setMuted(false);
    }
  }, [detachAllAudio]);

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiFetch('/api/voice/status', { signal });
      if (!res.ok) {
        if (mountedRef.current) setVoiceAvailable(false);
        return;
      }
      const data = (await res.json()) as VoiceStatusResponse;
      if (mountedRef.current) setVoiceAvailable(Boolean(data.enabled));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setVoiceAvailable(false);
    }
  }, []);

  const hangUp = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    resetLocalCall();
    if (mountedRef.current) {
      setCallState('idle');
      setError(null);
    }

    if (!activeSessionId) return;
    try {
      const res = await apiFetch(`/api/voice/sessions/${encodeURIComponent(activeSessionId)}`, {
        method: 'DELETE',
      });
      if (!res.ok && mountedRef.current) {
        setError(await readErrorMessage(res, 'The call ended locally, but Curia could not confirm hang up.'));
      }
    } catch (err) {
      if (mountedRef.current) setError(voiceErrorMessage(err));
    }
  }, [resetLocalCall]);

  const startCall = useCallback(async () => {
    if (callState === 'connecting' || callState === 'connected') return;

    startAbortRef.current?.abort();
    const controller = new AbortController();
    startAbortRef.current = controller;

    let createdSessionId: string | null = null;
    let room: Room | null = null;
    if (mountedRef.current) {
      setCallState('connecting');
      setError(null);
    }

    try {
      const res = await apiFetch('/api/voice/sessions', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, `Could not start voice call (${res.status}).`));
      }

      const session = (await res.json()) as VoiceSessionResponse;
      createdSessionId = session.sessionId;
      sessionIdRef.current = session.sessionId;
      if (mountedRef.current) setSessionId(session.sessionId);

      room = new Room();

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        attachRemoteAudio(track);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        detachRemoteAudio(track);
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        resetLocalCall(room);
        if (mountedRef.current) setCallState('idle');
      });

      roomRef.current = room;
      await room.connect(session.livekitUrl, session.token, { autoSubscribe: true });

      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.track) attachRemoteAudio(publication.track);
        }
      }

      await room.localParticipant.setMicrophoneEnabled(true);
      if (mountedRef.current) {
        setMuted(false);
        setCallState('connected');
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      resetLocalCall(room);
      if (createdSessionId) {
        void apiFetch(`/api/voice/sessions/${encodeURIComponent(createdSessionId)}`, {
          method: 'DELETE',
        });
      }
      if (mountedRef.current) {
        setError(voiceErrorMessage(err));
        setCallState('error');
      }
    } finally {
      if (startAbortRef.current === controller) startAbortRef.current = null;
    }
  }, [attachRemoteAudio, callState, detachRemoteAudio, resetLocalCall]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room || callState !== 'connected') return;

    const nextMuted = !muted;
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted);
      if (mountedRef.current) {
        setMuted(nextMuted);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(voiceErrorMessage(err));
    }
  }, [callState, muted]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchStatus(controller.signal);

    const refresh = () => {
      if (document.visibilityState === 'visible') void fetchStatus();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [fetchStatus]);

  useEffect(() => () => {
    mountedRef.current = false;
    startAbortRef.current?.abort();
    const activeSessionId = sessionIdRef.current;
    resetLocalCall();
    if (activeSessionId) {
      void apiFetch(`/api/voice/sessions/${encodeURIComponent(activeSessionId)}`, {
        method: 'DELETE',
      });
    }
  }, [resetLocalCall]);

  return {
    voiceAvailable,
    callState,
    muted,
    error,
    sessionId,
    startCall,
    toggleMute,
    hangUp,
  };
}
