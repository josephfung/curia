// identifier-sources.ts — the per-task `identifierSources` lookup (#2061, ADR-047).
//
// An identifier an agent enters is found when it occurs in a source-tool result indexed
// under the task's root conversation, or in a message a person sent there. The agent
// runtime and the voice bridge build one per task (voice: per tool call) with this.

import type { Logger } from '../logger.js';
import type { WorkingMemory } from '../memory/working-memory.js';
import { sourceKeyFor, sourceKeysInText, type IdentifierSources } from '../contacts/identifier-provenance.js';
import type { IdentifierSourceIndex } from './identifier-source-index.js';

const OUTBOUND_CONTEXT_HEADER = '[ACTIVE OUTBOUND CONTEXT';
const OUTBOUND_CONTEXT_END = '\n---\n\n';
// Where an email client starts quoting the message being answered, often one Curia
// wrote: "On Tue, Oct 7, 2026 at 3:00 PM Curia <…> wrote:", Outlook's separator, or a
// forwarded/quoted header block.
const QUOTED_HISTORY_START = /^(On .{1,300} wrote:\s*$|-{2,}\s*Original Message\s*-{2,}|From: .+\n(Sent|Date): )/m;

/**
 * The part of a stored person turn that a person wrote. Removes text that only looks
 * like theirs:
 * - the dispatcher's `[ACTIVE OUTBOUND CONTEXT]` block, which quotes Curia's own sends.
 *   It is not always first (email blocks are prepended after it), so it is cut from its
 *   header to the LAST block terminator: cutting too much drops some of the person's text
 *   (a refusal), cutting too little would let Curia's text through;
 * - quoted reply history, from the first quote marker on, and `>`-quoted lines.
 */
export function personTurnSourceText(content: string): string {
  let text = content;
  const start = text.indexOf(OUTBOUND_CONTEXT_HEADER);
  if (start !== -1) {
    const end = text.lastIndexOf(OUTBOUND_CONTEXT_END);
    text = end > start ? text.slice(0, start) + text.slice(end + OUTBOUND_CONTEXT_END.length) : text.slice(0, start);
  }
  const quoted = QUOTED_HISTORY_START.exec(text);
  if (quoted) text = text.slice(0, quoted.index);
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
}

export interface IdentifierSourcesOptions {
  index: IdentifierSourceIndex;
  /** Conversation source-tool results are indexed under (a delegation's origin). */
  sourceConversation: string;
  /** Working-memory rows holding the person's messages; absent when unknown. */
  personTurns?: { conversationId: string; agentId: string };
  memory?: WorkingMemory;
  logger: Logger;
}

/**
 * Lookup for one task. Person turns are read once, on the first lookup that the index
 * does not answer: the task's own turn is stored before its tools run. A failed read is
 * "not found" (the write is refused or stored unverified) and is retried on the next
 * lookup.
 */
export function createIdentifierSources(options: IdentifierSourcesOptions): IdentifierSources {
  const { index, sourceConversation, personTurns, memory, logger } = options;
  let personKeys: Set<string> | undefined;

  return {
    has: async (channel, identifier) => {
      const key = sourceKeyFor(channel, identifier);
      if (index.has(sourceConversation, key)) return true;
      if (!memory || !personTurns) return false;
      if (!personKeys) {
        try {
          const turns = await memory.getPersonTurns(personTurns.conversationId, personTurns.agentId);
          const keys = new Set<string>();
          for (const turn of turns) {
            for (const found of sourceKeysInText(personTurnSourceText(turn))) keys.add(found);
          }
          personKeys = keys;
        } catch (err) {
          logger.warn(
            { err, conversationId: personTurns.conversationId, agentId: personTurns.agentId },
            'identifier provenance: could not read person turns — treating as not found',
          );
          return false;
        }
      }
      return personKeys.has(key);
    },
  };
}
