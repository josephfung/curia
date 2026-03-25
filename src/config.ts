export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  logLevel: string;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
