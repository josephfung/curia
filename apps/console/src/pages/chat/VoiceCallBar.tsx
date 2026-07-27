import {
  IconMic,
  IconMicOff,
  IconPhone,
  IconPhoneOff,
} from '../../components/Icons.js';
import type { UseVoiceCallResult } from './useVoiceCall.js';

type VoiceCallBarProps = UseVoiceCallResult;

function statusText(callState: UseVoiceCallResult['callState'], muted: boolean): string {
  if (callState === 'connecting') return 'Connecting…';
  if (callState === 'connected') return muted ? 'On call · muted' : 'Listening…';
  return 'Voice call unavailable';
}

export function VoiceCallBar({
  voiceAvailable,
  callState,
  muted,
  error,
  startCall,
  toggleMute,
  hangUp,
}: VoiceCallBarProps) {
  // Keep mute / hang-up visible while a call is in progress even if a status
  // refresh briefly reports voice unavailable.
  if (!voiceAvailable && callState === 'idle') return null;

  if (callState === 'idle' || callState === 'error') {
    const retry = callState === 'error';
    return (
      <div className={`voice-call-bar ${callState}`}>
        <button
          type="button"
          className="btn btn-secondary btn-sm voice-call-start"
          onClick={() => void startCall()}
          aria-label={retry ? 'Try voice call again' : 'Start voice call'}
        >
          <IconPhone size={14} aria-hidden="true" />
          {retry ? 'Try again' : 'Voice'}
        </button>
        {error && <span className="voice-call-error">{error}</span>}
      </div>
    );
  }

  const connecting = callState === 'connecting';

  return (
    <div className={`voice-call-bar ${callState}`} role="status" aria-live="polite">
      <span className="voice-call-live-dot" aria-hidden="true" />
      <span className="voice-call-status">{statusText(callState, muted)}</span>
      {error && <span className="voice-call-error">{error}</span>}
      <span className="voice-call-spacer" />
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => void toggleMute()}
        disabled={connecting}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {muted ? <IconMicOff size={14} aria-hidden="true" /> : <IconMic size={14} aria-hidden="true" />}
        {muted ? 'Unmute' : 'Mute'}
      </button>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => void hangUp()}
        aria-label="Hang up voice call"
      >
        <IconPhoneOff size={14} aria-hidden="true" />
        Hang up
      </button>
    </div>
  );
}
