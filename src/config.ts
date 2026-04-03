export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  logLevel: string;
  httpPort: number;
  apiToken: string | undefined;
  timezone: string;
  nylasApiKey: string | undefined;
  nylasGrantId: string | undefined;
  nylasPollingIntervalMs: number;
  nylasSelfEmail: string;
  // CEO's primary email address. When set, the startup bootstrap ensures this
  // contact exists with status=confirmed and verified=true before any email arrives.
  // Without this, the first inbound email from the CEO creates them as provisional,
  // causing their messages to be held.
  ceoPrimaryEmail: string | undefined;
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

  const nylasPollingIntervalMs = parseInt(process.env.NYLAS_POLL_INTERVAL_MS ?? '30000', 10);
  if (isNaN(nylasPollingIntervalMs) || nylasPollingIntervalMs < 1000) {
    throw new Error(`NYLAS_POLL_INTERVAL_MS must be a number >= 1000, got: ${process.env.NYLAS_POLL_INTERVAL_MS}`);
  }

  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    httpPort,
    apiToken: process.env.API_TOKEN,
    timezone: process.env.TIMEZONE ?? 'America/Toronto',
    nylasApiKey: process.env.NYLAS_API_KEY,
    nylasGrantId: process.env.NYLAS_GRANT_ID,
    nylasPollingIntervalMs,
    nylasSelfEmail: process.env.NYLAS_SELF_EMAIL ?? '',
    ceoPrimaryEmail: process.env.CEO_PRIMARY_EMAIL?.trim().toLowerCase() || undefined,
  };
}
