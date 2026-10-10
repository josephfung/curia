// The assistant's email signature, added by the gateway to every email it writes
// (prompt trim PR 6). The signature is the office identity's `emailSignature` setting;
// it was configured in the console but read by nothing, while the coordinator prompt
// told the model to sign with its name and title. Applying it in code makes the
// setting do what it says.

import type { AgentPersona } from '../../skills/types.js';
import { EMAIL_WRAPPER_STYLE } from '../../format/markdown-to-html.js';

/** The signature to add, or undefined when there is no persona to sign as. */
export function emailSignatureText(persona: AgentPersona | undefined): string | undefined {
  if (!persona) return undefined;
  const configured = persona.emailSignature?.trim();
  if (configured) return configured;
  // AgentPersona's contract: with no signature set, build one from name and title.
  const fallback = [persona.displayName, persona.title].map(s => s?.trim()).filter(Boolean).join('\n');
  return fallback || undefined;
}

/** Lowercased words of the text, ignoring a `--` delimiter line and markdown emphasis. */
function signatureWords(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^-{2,}$/.test(line))
    .join(' ')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * True when the body already ends with the signature: the model signed it the same
 * way, or the text was signed once already. Adding it again would sign twice. A short
 * sign-off ("Best, Alex") is not the signature, and the signature still goes below it.
 */
export function bodyEndsWithSignature(body: string, signature: string): boolean {
  const sig = signatureWords(signature);
  return sig !== '' && signatureWords(body).endsWith(sig);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The signature as HTML, styled like the body. Plain text, not markdown: a signature
 * line such as `---` or `*Title*` is shown as written. Empty when there is none.
 */
export function emailSignatureHtml(signature: string | undefined): string {
  const text = signature?.trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map(line => escapeHtml(line.trimEnd()));
  return `\n<div style="${EMAIL_WRAPPER_STYLE}">\n<p>${lines.join('<br>\n')}</p>\n</div>`;
}
