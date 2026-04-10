import pino from 'pino';
import { Writable } from 'node:stream';

/**
 * Create a pino logger instance.
 *
 * In production, outputs structured JSON to stdout for log aggregators.
 * In dev/CLI mode, logs to a file (curia.log) to keep the interactive
 * terminal clean. The CLI adapter owns stdout — pino must not write to it
 * or it will corrupt the readline prompt and swallow signals.
 */
export function createLogger(level: string = 'info'): pino.Logger {
  const isProduction = process.env.NODE_ENV === 'production';

  // Last-resort redaction for common secret and PII field names.
  //
  // Primary defenses:
  //   - ctx.secret() interface prevents secret values from reaching the logger
  //   - Logging call sites should use contact IDs / conversation IDs, not raw PII values
  //   - scrubPii() in src/pii/scrubber.ts strips PII from error strings before LLM context
  //
  // This redact config is a safety net for structured log fields — it catches
  // accidental leakage when an object with a known PII field name is logged
  // (e.g. `logger.info({ senderId, channelId }, '...')`).
  //
  // Depth note: pino v10 uses @pinojs/redact which supports single-level wildcards
  // ('*.field') but NOT deep wildcards ('**.field'). The two-level 'a.*.field' paths
  // cover the most common nesting depth. For deeper nesting the primary call-site
  // discipline must hold — this is a safety net, not a guarantee.
  const redact = {
    paths: [
      // Secrets
      'password', '*.password', '*.*.password',
      'token', '*.token', '*.*.token',
      'secret', '*.secret', '*.*.secret',
      'api_key', '*.api_key', '*.*.api_key',
      // PII — sender identifiers (email addresses, phone numbers).
      // 'senderId' covers raw email/phone logged by the dispatcher and channel adapters.
      // 'email' covers participant email fields logged by the email adapter.
      // 'senderEmail' covers renamed log fields in the email adapter (more specific than
      //   'from', which also appears in non-PII contexts like date ranges).
      // 'phoneNumber' covers E.164 phone numbers logged as a named field.
      'senderId', '*.senderId', '*.*.senderId',
      'email', '*.email', '*.*.email',
      'senderEmail', '*.senderEmail', '*.*.senderEmail',
      'phoneNumber', '*.phoneNumber', '*.*.phoneNumber',
    ],
    censor: '[REDACTED]',
  };

  if (isProduction) {
    return pino({ level, redact });
  }

  // Dev mode: write to curia.log instead of stdout so the CLI stays clean.
  // Use pino-pretty for readable format in the log file.
  return pino({
    level,
    redact,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: false,
        ignore: 'pid,hostname',
        destination: 'curia.log',
        mkdir: true,
      },
    },
  });
}

/**
 * Create a silent logger that discards all output.
 * Useful for tests where log output is noise.
 */
export function createSilentLogger(): pino.Logger {
  const devNull = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  return pino({ level: 'silent' }, devNull);
}

export type Logger = pino.Logger;
