// platform-keys.ts — the vault keys Curia reads directly at boot (applyVaultSecrets
// and the web-push VAPID bootstrap). They are not declared by any skill or channel,
// so the console would otherwise show them as unknown secrets. The Secrets page lists
// them read-only and refuses writes to them: changing one is a deployment concern,
// not something to do from the console. A drift-guard test asserts that every key
// applyVaultSecrets reads appears here.
import { VAPID_SECRET_NAME } from '../channels/web/vapid.js';

export const PLATFORM_VAULT_KEYS: ReadonlyMap<string, string> = new Map([
  ['anthropic_api_key', 'LLM provider (Anthropic)'],
  ['openai_api_key', 'LLM provider (OpenAI)'],
  ['openrouter_api_key', 'LLM provider (OpenRouter)'],
  ['aws_access_key_id', 'LLM provider (AWS Bedrock)'],
  ['aws_secret_access_key', 'LLM provider (AWS Bedrock)'],
  ['embedding_api_key', 'Embeddings'],
  ['api_token', 'HTTP API token'],
  ['web_app_bootstrap_secret', 'Console sign-in'],
  ['nylas_api_key', 'Nylas (legacy email)'],
  ['nylas_grant_id', 'Nylas (legacy email)'],
  ['nylas_self_email', 'Nylas (legacy email)'],
  [VAPID_SECRET_NAME, 'Web push keys'],
]);

export function isPlatformVaultKey(name: string): boolean {
  return PLATFORM_VAULT_KEYS.has(name);
}

export function platformKeyLabel(name: string): string | undefined {
  return PLATFORM_VAULT_KEYS.get(name);
}
