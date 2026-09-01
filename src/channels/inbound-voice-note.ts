// Shared inbound voice-note helpers for Signal + Slack (#1600).
//
// Adapters download attachment bytes, call SpeechMediaService.transcribe(), and
// inject the transcript as ordinary inbound.message content tagged for provenance.
// This module owns MIME detection and the publish/drop policy — not the download.

import type { AgentError } from '../errors/types.js';
import type { SpeechMediaResult, TranscribeFileResult } from '../speech/index.js';

/** Provenance marker on inbound content so agents can see the source. */
export const TRANSCRIBED_FROM_AUDIO_TAG = '[transcribed-from-audio]';

const EMPTY_TRANSCRIPT_NOTE = "couldn't make that out";

export interface AudioAttachmentHint {
  contentType?: string;
  isVoiceNote?: boolean;
}

export interface SlackAudioFileHint {
  id?: string;
  mimetype?: string;
  filetype?: string;
  subtype?: string;
  media_display_type?: string;
  url_private_download?: string;
  url_private?: string;
}

export interface VoiceNotePublish {
  content: string;
  transcribedFromAudio: true;
  transcriptionError?: Pick<AgentError, 'type' | 'message' | 'retryable'>;
}

/** True for audio/* and application/ogg (Signal opus sometimes uses the latter). */
export function isAudioContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  return mime.startsWith('audio/') || mime === 'application/ogg';
}

export function isAudioAttachment(att: AudioAttachmentHint): boolean {
  return att.isVoiceNote === true || isAudioContentType(att.contentType);
}

export function findFirstAudioAttachment<T extends AudioAttachmentHint>(
  attachments: readonly T[] | undefined,
): T | undefined {
  if (!attachments?.length) return undefined;
  return attachments.find(isAudioAttachment);
}

export function isSlackAudioFile(file: SlackAudioFileHint): boolean {
  if (isAudioContentType(file.mimetype)) return true;
  if (file.media_display_type === 'audio') return true;
  const subtype = file.subtype?.toLowerCase();
  if (subtype === 'slack_audio' || subtype === 'voice_message') return true;
  const ft = file.filetype?.toLowerCase();
  return (
    ft === 'm4a' ||
    ft === 'webm' ||
    ft === 'mp3' ||
    ft === 'ogg' ||
    ft === 'opus' ||
    ft === 'aac' ||
    ft === 'wav'
  );
}

export function findFirstSlackAudioFile<T extends SlackAudioFileHint>(
  files: readonly T[] | undefined,
): T | undefined {
  if (!files?.length) return undefined;
  return files.find(isSlackAudioFile);
}

export function slackFileDownloadUrl(file: SlackAudioFileHint): string | undefined {
  const download = file.url_private_download?.trim();
  if (download) return download;
  const priv = file.url_private?.trim();
  return priv || undefined;
}

export function slackFileContentType(file: SlackAudioFileHint): string | undefined {
  if (file.mimetype?.trim()) return file.mimetype.trim();
  const ft = file.filetype?.toLowerCase();
  if (ft === 'm4a' || ft === 'mp4') return 'audio/mp4';
  if (ft === 'webm') return 'audio/webm';
  if (ft === 'mp3') return 'audio/mpeg';
  if (ft === 'ogg' || ft === 'opus') return 'audio/ogg';
  if (ft === 'aac') return 'audio/aac';
  if (ft === 'wav') return 'audio/wav';
  return undefined;
}

/**
 * Map an STT result onto inbound content.
 *
 * Empty transcripts are success, not failure — never publish `content: ''`.
 * Failures surface `error.type` + `error.message` in the body (never silent drop).
 */
export function resolveVoiceNoteInbound(opts: {
  originalText: string;
  result: SpeechMediaResult<TranscribeFileResult>;
}): VoiceNotePublish {
  if (!opts.result.ok) {
    const { type, message, retryable } = opts.result.error;
    return {
      content: formatVoiceNoteContent(
        opts.originalText,
        `Voice note transcription failed (${type}): ${message}`,
      ),
      transcribedFromAudio: true,
      transcriptionError: { type, message, retryable },
    };
  }

  const transcript = opts.result.value.text.trim();
  if (!transcript) {
    return {
      content: formatVoiceNoteContent(opts.originalText, EMPTY_TRANSCRIPT_NOTE),
      transcribedFromAudio: true,
    };
  }

  return {
    content: formatVoiceNoteContent(opts.originalText, transcript),
    transcribedFromAudio: true,
  };
}

export function voiceNoteDownloadFailure(originalText: string, err: unknown): VoiceNotePublish {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: formatVoiceNoteContent(originalText, `Voice note download failed: ${message}`),
    transcribedFromAudio: true,
  };
}

function formatVoiceNoteContent(originalText: string, body: string): string {
  const tagged = `${TRANSCRIBED_FROM_AUDIO_TAG}\n${body}`;
  return originalText ? `${originalText}\n\n${tagged}` : tagged;
}
