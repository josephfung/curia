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

/** A sign-off line, lowercased, without emphasis, a leading dash or trailing punctuation. */
function signOffText(line: string): string {
  return line
    .replace(/[*_]/g, '')
    .trim()
    .replace(/^[-–—~]+\s*/, '')
    .replace(/[.,!;:]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * True when the line names only the assistant: its name or a part of it, its title, or
 * a line of the signature, alone or joined by commas, bars or dashes ("Alex Curia, Digital
 * EA"). A sentence that mentions the name ("Alex will follow up Monday.") is not.
 */
function isSignOffLine(line: string, phrases: ReadonlySet<string>): boolean {
  const segments = signOffText(line).split(/\s*[,|·]\s*|\s+[-–—]\s+/);
  return segments.every(segment => phrases.has(segment));
}

/**
 * The body without the sign-off block the model wrote at its end, so the gateway's
 * signature is the only one (#2138). The model still signs sometimes, in forms that
 * differ from the configured signature ("Alex" over the signature's second line, or name
 * and persona title), and each near miss went out signed twice. The block is the trailing
 * lines that name only the assistant (see isSignOffLine), with any blank or `--` lines
 * among them. A bare first name is part of it: "Alex" over "Alex Curia" reads as signing
 * twice. A valediction ("Best,") is not, and stays above the signature. Unchanged when
 * there is no such block, or when it is the whole body.
 */
export function stripModelSignOff(body: string, persona: AgentPersona, signature: string): string {
  const phrases = new Set<string>();
  const nameParts = persona.displayName.split(/\s+/);
  for (const phrase of [persona.displayName, persona.title, ...nameParts, ...signature.split('\n')]) {
    const text = signOffText(phrase);
    if (text !== '' && !/^-+$/.test(text)) phrases.add(text);
  }

  const lines = body.split(/\r?\n/);
  let end = lines.length;
  let signOffLines = 0;
  while (end > 0) {
    const line = lines[end - 1]!.trim();
    if (line === '' || /^-{2,}$/.test(line)) {
      end--;
    } else if (isSignOffLine(line, phrases)) {
      end--;
      signOffLines++;
    } else {
      break;
    }
  }
  if (signOffLines === 0 || end === 0) return body;
  return lines.slice(0, end).join('\n').trimEnd();
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
