import { describe, expect, it } from 'vitest';
import { SttHttpError } from '../speech/index.js';
import { classifyError } from '../errors/classify.js';
import {
  TRANSCRIBED_FROM_AUDIO_TAG,
  findFirstAudioAttachment,
  findFirstSlackAudioFile,
  isAudioContentType,
  isSlackAudioFile,
  resolveVoiceNoteInbound,
  slackFileContentType,
  slackFileDownloadUrl,
  voiceNoteDownloadFailure,
} from './inbound-voice-note.js';

describe('isAudioContentType', () => {
  it('accepts audio/* and application/ogg', () => {
    expect(isAudioContentType('audio/ogg')).toBe(true);
    expect(isAudioContentType('audio/mp4; codecs=mp4a.40.2')).toBe(true);
    expect(isAudioContentType('application/ogg')).toBe(true);
  });

  it('rejects non-audio types', () => {
    expect(isAudioContentType('image/png')).toBe(false);
    expect(isAudioContentType('application/octet-stream')).toBe(false);
    expect(isAudioContentType(undefined)).toBe(false);
  });
});

describe('findFirstAudioAttachment', () => {
  it('prefers isVoiceNote even when contentType is generic', () => {
    const found = findFirstAudioAttachment([
      { id: 'img', contentType: 'image/jpeg' },
      { id: 'vn', contentType: 'application/octet-stream', isVoiceNote: true },
    ]);
    expect(found?.id).toBe('vn');
  });
});

describe('Slack audio files', () => {
  it('detects mimetype, slack_audio subtype, and m4a/webm filetypes', () => {
    expect(isSlackAudioFile({ mimetype: 'audio/webm' })).toBe(true);
    expect(isSlackAudioFile({ subtype: 'slack_audio' })).toBe(true);
    expect(isSlackAudioFile({ filetype: 'm4a' })).toBe(true);
    expect(isSlackAudioFile({ filetype: 'mp4' })).toBe(false);
    expect(isSlackAudioFile({ mimetype: 'image/png' })).toBe(false);
  });

  it('prefers url_private_download and maps filetype to a MIME hint', () => {
    expect(slackFileDownloadUrl({
      url_private: 'https://files.slack.com/a',
      url_private_download: 'https://files.slack.com/b',
    })).toBe('https://files.slack.com/b');
    expect(slackFileContentType({ filetype: 'm4a' })).toBe('audio/mp4');
    expect(slackFileContentType({ mimetype: 'audio/webm;codecs=opus' })).toBe('audio/webm;codecs=opus');
  });

  it('returns the first audio file', () => {
    const found = findFirstSlackAudioFile([
      { id: 'Fimg', mimetype: 'image/png' },
      { id: 'Faud', mimetype: 'audio/mp4' },
    ]);
    expect(found?.id).toBe('Faud');
  });
});

describe('resolveVoiceNoteInbound', () => {
  it('injects the transcript tagged transcribed-from-audio', () => {
    const resolved = resolveVoiceNoteInbound({
      originalText: '',
      result: { ok: true, value: { text: '  schedule lunch  ' } },
    });
    expect(resolved.content).toBe(`${TRANSCRIBED_FROM_AUDIO_TAG}\nschedule lunch`);
    expect(resolved.transcribedFromAudio).toBe(true);
  });

  it('keeps original caption ahead of the tagged transcript', () => {
    const resolved = resolveVoiceNoteInbound({
      originalText: 'see voice note',
      result: { ok: true, value: { text: 'hello' } },
    });
    expect(resolved.content).toBe(`see voice note\n\n${TRANSCRIBED_FROM_AUDIO_TAG}\nhello`);
  });

  it('does not produce empty content for an empty transcript', () => {
    const resolved = resolveVoiceNoteInbound({
      originalText: '',
      result: { ok: true, value: { text: '' } },
    });
    expect(resolved.content.length).toBeGreaterThan(0);
    expect(resolved.content).toContain(TRANSCRIBED_FROM_AUDIO_TAG);
    expect(resolved.content).toContain("couldn't make that out");
  });

  it('surfaces error type and message on transcription failure', () => {
    const error = classifyError(new SttHttpError(429, 'rate limited'), 'stt:deepgram');
    const resolved = resolveVoiceNoteInbound({
      originalText: '',
      result: { ok: false, error },
    });
    expect(resolved.content).toContain('RATE_LIMIT');
    expect(resolved.content).toContain('rate limited');
    expect(resolved.transcriptionError).toEqual({
      type: 'RATE_LIMIT',
      message: error.message,
      retryable: true,
    });
  });
});

describe('voiceNoteDownloadFailure', () => {
  it('surfaces the download error without dropping', () => {
    const resolved = voiceNoteDownloadFailure('', new Error('socket closed'));
    expect(resolved.content).toContain('Voice note download failed: socket closed');
    expect(resolved.content).toContain(TRANSCRIBED_FROM_AUDIO_TAG);
  });
});
