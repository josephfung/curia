import pino from 'pino';

export function createLogger(level: string = 'info'): pino.Logger {
  return pino({
    level,
    // Use pino-pretty for human-readable output in debug mode only;
    // production/info mode keeps structured JSON for log aggregators.
    transport: level === 'debug'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  });
}

export type Logger = pino.Logger;
