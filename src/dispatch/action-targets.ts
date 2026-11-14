// action-targets.ts — read "who/what does this tool call affect" from its input.
//
// The pre-action backstop (#2588) compares these targets against what other
// concurrent turns already acted on. Targets come from the input's values, not
// its field names, so no per-tool knowledge is needed.

import { isUuid } from '../util/uuid.js';
import type { ActionTarget } from './turn-activity.js';

const MAX_DEPTH = 6;
const MAX_STRINGS = 50;
const MAX_CONTACT_CHECKS = 10;
const OTHER_ID_RE = /^[A-Za-z0-9_\-:.]+$/;

export interface CandidateValues {
  uuids: string[];
  hosts: string[];
  otherIds: string[];
}

function hostOf(s: string): string | undefined {
  if (!/^https?:\/\//i.test(s)) return undefined;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return (host.startsWith('www.') ? host.slice(4) : host) || undefined;
  } catch {
    // Not a parseable URL: it is simply not a site candidate.
    return undefined;
  }
}

/**
 * Walk the input (depth <= 6 below the top-level object, first 50 strings in
 * depth-first insertion order) and classify string values.
 */
export function collectCandidateValues(input: Record<string, unknown>): CandidateValues {
  const uuids = new Set<string>();
  const hosts = new Set<string>();
  const otherIds = new Set<string>();
  let seen = 0;

  const classify = (s: string): void => {
    // Annotated as boolean so the type guard does not narrow `s` to never below.
    const uuidShaped: boolean = isUuid(s);
    if (uuidShaped) {
      uuids.add(s.toLowerCase());
      return;
    }
    const host = hostOf(s);
    if (host !== undefined) {
      hosts.add(host);
      return;
    }
    if (s.includes('@') || s.includes('://')) return;
    if (s.length >= 8 && s.length <= 128 && OTHER_ID_RE.test(s) && /\d/.test(s)) {
      otherIds.add(s);
    }
  };

  const walk = (value: unknown, depth: number): void => {
    if (seen >= MAX_STRINGS) return;
    if (typeof value === 'string') {
      seen++;
      classify(value);
      return;
    }
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      walk(child, depth + 1);
    }
  };

  walk(input, 0);
  return { uuids: [...uuids], hosts: [...hosts], otherIds: [...otherIds] };
}

/**
 * Derive the targets of a tool call. Contacts and sites win; only when neither
 * is present do we fall back to raw ids plus the tool name, so a shared
 * non-contact UUID (e.g. a mailbox) never links two unrelated contact sends.
 * An `isContact` rejection propagates; the caller fails open.
 */
export async function extractActionTargets(
  toolName: string,
  input: Record<string, unknown>,
  deps: { principalContactId: string | undefined; isContact: (id: string) => Promise<boolean> },
): Promise<ActionTarget[]> {
  const { uuids, hosts, otherIds } = collectCandidateValues(input);
  const principal = deps.principalContactId?.toLowerCase();
  const candidates = uuids.filter((u) => u !== principal);
  const checked = candidates.slice(0, MAX_CONTACT_CHECKS);
  const flags = await Promise.all(checked.map((id) => deps.isContact(id)));

  const contactIds = checked.filter((_, i) => flags[i]);
  const targets: ActionTarget[] = [
    ...contactIds.map((value): ActionTarget => ({ kind: 'contact', value })),
    ...hosts.map((value): ActionTarget => ({ kind: 'site', value })),
  ];
  if (targets.length > 0) return targets;

  const contactSet = new Set(contactIds);
  return [
    ...candidates.filter((u) => !contactSet.has(u)).map((value): ActionTarget => ({ kind: 'id', value })),
    ...otherIds.map((value): ActionTarget => ({ kind: 'id', value })),
    { kind: 'tool', value: toolName },
  ];
}
