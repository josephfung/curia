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

  // Last-resort redaction for common secret field names. The primary defense is the
  // ctx.secret() interface — secret values should never reach the logger in the first
  // place. This catches accidental leakage (e.g. logging an object that happens to
  // contain a 'token' field). Wildcard prefix covers one level of nesting.
  const redact = {
    paths: ['password', '*.password', 'token', '*.token', 'secret', '*.secret', 'api_key', '*.api_key'],
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
