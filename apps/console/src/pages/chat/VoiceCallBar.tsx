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
  if (!voiceAvailable && callState !== 'error') return null;

  if (callState === 'idle' || callState === 'error') {
    return (
      <div className={`voice-call-bar ${callState}`}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void startCall()}
          aria-label={callState === 'error' ? 'Try voice call again' : 'Start voice call'}
        >
          {callState === 'error' ? 'Try call again' : 'Call'}
        </button>
        {error && <span className="voice-call-error">{error}</span>}
      </div>
    );
  }

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
        disabled={callState !== 'connected'}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => void hangUp()}
        aria-label="Hang up voice call"
      >
        Hang up
      </button>
    </div>
  );
}
