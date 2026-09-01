// Shared inbound voice-note helpers for Signal + Slack (#1600).
//
// Adapters download attachment bytes, call SpeechMediaService.transcribe(), and
// inject the transcript as ordinary inbound.message content tagged for provenance.
// This module owns MIME detection and the publish/drop policy — not the download.

import type { AgentError } from '../errors/types.js';
import type { SpeechMediaResult, TranscribeFileResult } from '../speech/index.js';

/** Provenance marker on inbound content so agents can see the source. */
export const TRANSCRIBED_FROM_AUDIO_TAG = '[transcribed-from-audio]';

/**
 * Upper bound on a voice-note download (Signal `getAttachment` / Slack file fetch)
 * and therefore on per-message Deepgram spend. A few MB is generous for opus/m4a
 * voice memos; Signal itself allows 100 MB attachments, which we must not pull
 * through the JSON-RPC line buffer (#1600 review).
 */
export const MAX_VOICE_NOTE_BYTES = 5 * 1024 * 1024;

const EMPTY_TRANSCRIPT_NOTE = "couldn't make that out";
const USER_SAFE_PROCESS_FAILURE =
  "couldn't process that voice note, could you send it as text?";
const USER_SAFE_TOO_LARGE = 'voice note too long to transcribe';

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
  size?: number;
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

export function countAudioAttachments(
  attachments: readonly AudioAttachmentHint[] | undefined,
): number {
  if (!attachments?.length) return 0;
  return attachments.filter(isAudioAttachment).length;
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

export function countSlackAudioFiles(
  files: readonly SlackAudioFileHint[] | undefined,
): number {
  if (!files?.length) return 0;
  return files.filter(isSlackAudioFile).length;
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

export function isVoiceNoteOversize(size: number | undefined): size is number {
  return typeof size === 'number' && Number.isFinite(size) && size > MAX_VOICE_NOTE_BYTES;
}

/**
 * Map an STT result onto inbound content.
 *
 * Empty transcripts are success, not failure — never publish `content: ''`.
 * Failures never silent-drop: `content` is a user-safe prompt to resend as text;
 * `transcriptionError` keeps type/message/retryable for operators.
 */
export function resolveVoiceNoteInbound(opts: {
  originalText: string;
  result: SpeechMediaResult<TranscribeFileResult>;
  skippedAudioCount?: number;
}): VoiceNotePublish {
  if (!opts.result.ok) {
    const { type, message, retryable } = opts.result.error;
    return {
      content: formatVoiceNoteContent(
        opts.originalText,
        USER_SAFE_PROCESS_FAILURE,
        opts.skippedAudioCount,
      ),
      transcribedFromAudio: true,
      transcriptionError: { type, message, retryable },
    };
  }

  const transcript = opts.result.value.text.trim();
  const body = transcript || EMPTY_TRANSCRIPT_NOTE;
  return {
    content: formatVoiceNoteContent(opts.originalText, body, opts.skippedAudioCount),
    transcribedFromAudio: true,
  };
}

export function voiceNoteDownloadFailure(
  originalText: string,
  err: unknown,
  skippedAudioCount?: number,
): VoiceNotePublish {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: formatVoiceNoteContent(originalText, USER_SAFE_PROCESS_FAILURE, skippedAudioCount),
    transcribedFromAudio: true,
    transcriptionError: { type: 'UNKNOWN', message, retryable: true },
  };
}

export function voiceNoteTooLarge(
  originalText: string,
  size: number,
  skippedAudioCount?: number,
): VoiceNotePublish {
  return {
    content: formatVoiceNoteContent(originalText, USER_SAFE_TOO_LARGE, skippedAudioCount),
    transcribedFromAudio: true,
    transcriptionError: {
      type: 'VALIDATION_ERROR',
      message: `voice note size ${size} exceeds cap ${MAX_VOICE_NOTE_BYTES}`,
      retryable: false,
    },
  };
}

function skippedAudioLine(skipped: number | undefined): string | undefined {
  if (!skipped || skipped <= 0) return undefined;
  return skipped === 1
    ? '1 more voice note not transcribed'
    : `${skipped} more voice notes not transcribed`;
}

function formatVoiceNoteContent(
  originalText: string,
  body: string,
  skippedAudioCount?: number,
): string {
  const extra = skippedAudioLine(skippedAudioCount);
  const tagged = extra
    ? `${TRANSCRIBED_FROM_AUDIO_TAG}\n${body}\n${extra}`
    : `${TRANSCRIBED_FROM_AUDIO_TAG}\n${body}`;
  return originalText ? `${originalText}\n\n${tagged}` : tagged;
}
