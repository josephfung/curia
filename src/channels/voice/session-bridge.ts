import type { VoiceCallerContext } from './caller-context.js';

export interface VoiceSessionCreateRequest {
  /** Resolved caller identity (originator / tier / liveTurn) — stamped once at create. */
  caller: VoiceCallerContext;
  metadata?: Record<string, unknown>;
}

export interface VoiceSessionCreateResult {
  status: number;
  body: Record<string, unknown>;
}

export type VoiceSessionHandler = {
  createSession(req: VoiceSessionCreateRequest): Promise<VoiceSessionCreateResult>;
  endSession(sessionId: string): Promise<VoiceSessionCreateResult>;
  status(): Promise<{ enabled: true } | { enabled: false }>;
};

/**
 * Mutable bridge: VoiceAdapter.start() installs the handler; stop() clears it.
 * HTTP routes stay mounted and return 503 when the voice channel is not started.
 */
export class VoiceSessionBridge {
  private handler: VoiceSessionHandler | null = null;

  setHandler(handler: VoiceSessionHandler | null): void {
    this.handler = handler;
  }

  getHandler(): VoiceSessionHandler | null {
    return this.handler;
  }
}
