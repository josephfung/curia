export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  logLevel: string;
  httpPort: number;
  apiToken: string | undefined;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3000', 10);
  if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`HTTP_PORT must be a valid port number (1-65535), got: ${process.env.HTTP_PORT}`);
  }

  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    httpPort,
    apiToken: process.env.API_TOKEN,
  };
}
