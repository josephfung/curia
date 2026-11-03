// principal-reach-channel-lists.test.ts — a model-facing text must not hand-copy a channel
// list narrower than REACH_CHANNELS (#2440).
//
// async-offramp once said "signal | email, defaults to email" (#2433 review): a principal on
// the phone app, SMS or Slack was never reached on their channel, and their standing
// preferences were bypassed. Which channel reaches the principal is decided by the
// "Reaching the principal" block (src/agents/principal-reach.ts), not by a list in a manifest
// or a shared prompt. Text that needs a channel says "their usual channel", or names all of
// REACH_CHANNELS.
//
// Scope: tool.json (descriptions and inputs), src/agents/prompts/*.ts, agents/*.yaml.
// Out of scope: lists of tool names (`signal-send`), identity kinds in the contact tools,
// and transports (adapters, the gateway) — none of those are model-facing choices of channel.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REACH_CHANNELS } from '../../../src/agents/principal-reach.js';

const ROOT = path.join(import.meta.dirname, '../../..');

// Words that name a reach channel in prose or a union, and the channel each one stands for.
const WORD_TO_CHANNEL: Record<string, string> = {
  signal: 'signal',
  sms: 'sms',
  slack: 'slack',
  email: 'email',
  web: 'web',
  'phone app': 'web',
  'the phone app': 'web',
};
const WORD = '(?:the phone app|phone app|signal|sms|slack|email|web)';
// Two or more channel words joined by commas, "or", "and", "|" or "/", not part of a tool
// name (`signal-send`) or a longer word.
const LIST = new RegExp(
  `(?<![\\w-])${WORD}(?![\\w-])(?:\\s*(?:,|\\||/|\\bor\\b|\\band\\b)\\s*(?:(?:or|and)\\s+)?${WORD}(?![\\w-]))+`,
  'gi',
);

export function channelListsIn(text: string): { text: string; channels: Set<string> }[] {
  return [...text.matchAll(LIST)].map((match) => ({
    text: match[0],
    channels: new Set(
      [...match[0].toLowerCase().matchAll(new RegExp(WORD, 'g'))].map((word) => WORD_TO_CHANNEL[word[0]]!),
    ),
  }));
}

/** Lists that name some reach channels but not all of them. */
export function narrowChannelLists(text: string): string[] {
  return channelListsIn(text)
    .filter((list) => list.channels.size >= 2 && REACH_CHANNELS.some((channel) => !list.channels.has(channel)))
    .map((list) => list.text);
}

function manifestPaths(): string[] {
  const skills = path.join(ROOT, 'skills');
  const found: string[] = [];
  for (const entry of fs.readdirSync(skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const flat = path.join(skills, entry.name, 'tool.json');
    if (fs.existsSync(flat)) found.push(flat);
    const tools = path.join(skills, entry.name, 'tools');
    if (!fs.existsSync(tools)) continue;
    for (const tool of fs.readdirSync(tools, { withFileTypes: true })) {
      const nested = path.join(tools, tool.name, 'tool.json');
      if (tool.isDirectory() && fs.existsSync(nested)) found.push(nested);
    }
  }
  return found;
}

function filesIn(dir: string, extension: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith(extension)).map((name) => path.join(ROOT, dir, name));
}

// Entries are `<repo-relative path>: <matched list, lowercased>`, each with its reason.
// Every one names something other than a way to reach the principal.
const ALLOWED = new Map<string, string>([
  ['skills/contacts/tools/contact-create/tool.json: sms or signal', 'which identity kinds a phone number can become'],
  ['skills/contacts/tools/contact-link-identity/tool.json: signal, sms', 'identity kinds that take a phone number'],
  ['skills/verification/tool.json: email|sms', 'how the invitation link is delivered, set by the operator'],
  ['agents/setup-wizard.yaml: email, signal', 'which channels are configured in the console during setup'],
]);

describe('hard-coded principal channel lists (#2440)', () => {
  it('the scanner reads the shapes that bit us', () => {
    expect(narrowChannelLists('(signal | email — channel to reach the principal)')).toEqual(['signal | email']);
    expect(narrowChannelLists('Deliver it on Signal or email.')).toEqual(['Signal or email']);
    expect(narrowChannelLists('proactively on Signal, SMS, Slack, or email.')).toEqual(['Signal, SMS, Slack, or email']);
    expect(narrowChannelLists('Use signal-send, sms-send or email-send.')).toEqual([]);
    expect(narrowChannelLists('their usual channel')).toEqual([]);
    expect(narrowChannelLists('signal | sms | web | slack | email')).toEqual([]);
    expect(narrowChannelLists('the phone app, Signal, SMS, Slack or email')).toEqual([]);
  });

  const targets = [
    ...manifestPaths(),
    ...filesIn('src/agents/prompts', '.ts').filter((file) => !file.endsWith('index.ts')),
    ...filesIn('agents', '.yaml'),
  ];

  it('scans the manifests, prompts and agents', () => {
    expect(targets.length).toBeGreaterThan(100);
  });

  it.each(targets.map((file) => path.relative(ROOT, file)))('%s names no channel list narrower than REACH_CHANNELS', (relative) => {
    const lists = narrowChannelLists(fs.readFileSync(path.join(ROOT, relative), 'utf8'))
      .filter((list) => !ALLOWED.has(`${relative}: ${list.toLowerCase()}`));
    expect(lists, `${relative} hand-copies a channel list. Defer to "Reaching the principal" ("their usual channel"), or derive the list from REACH_CHANNELS.`).toEqual([]);
  });
});
