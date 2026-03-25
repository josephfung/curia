import pino from 'pino';

/**
 * Create a pino logger instance.
 *
 * In interactive/dev mode (NODE_ENV !== 'production'), uses pino-pretty
 * for human-readable output so JSON logs don't pollute the terminal.
 * In production, outputs structured JSON for log aggregators.
 */
export function createLogger(level: string = 'info'): pino.Logger {
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    level,
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
      : undefined,
  });
}

export type Logger = pino.Logger;
