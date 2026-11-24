// backfill.ts — create contacts from the deep-dive history summary (#2362).
//
// Candidates are the two-way person correspondents plus the attendees of recurring meetings,
// minus the principal's own addresses and calendar room resources. Creation mirrors the email
// adapter's participant path (`extractParticipants`): resolve, create, link, and on a failed
// link delete the contact again so no identity-less row is left behind (#946).
//
// Summary text is outsider-controlled (display names come from any sender): names are used only
// as display names, trimmed, with the email as the fallback; createContact sanitizes them again.
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import { classifyEmailSender, deriveOrgLabelFromDomain } from '../../contacts/contact-service.js';
import { isNonOrgDomain } from '../../contacts/non-org-domains.js';
import { BACKFILL_CAP } from './limits.js';
import type { HistorySummary } from './history-summary.js';
import { domainOf, normaliseAddress } from './summary-util.js';

export interface BackfillDeps {
  contactService: Pick<ContactService, 'resolveByChannelIdentity' | 'createContactWithKgOutcome' | 'linkIdentity' | 'deleteContact'>;
  logger: Logger;
}

type Source = 'email_participant' | 'calendar_attendee';
interface Candidate {
  email: string;
  name: string;
  source: Source;
}

/** Google Calendar room and equipment resources show up as attendees; they are not people. */
const RESOURCE_DOMAIN = 'resource.calendar.google.com';

/**
 * The correspondents who write both ways (people only), busiest first, then the recurring-meeting
 * attendees not already listed, in the order of how many recurring meetings they attend.
 */
function candidatesOf(summary: HistorySummary): Candidate[] {
  const principal = new Set(summary.principalAddresses.map(normaliseAddress));
  const usable = (email: string): boolean => email !== '' && !principal.has(email) && domainOf(email) !== RESOURCE_DOMAIN;
  const out = new Map<string, Candidate>();

  const people = summary.correspondents
    .filter((c) => c.twoWay && c.kind === 'person')
    .map((c) => ({ c, email: normaliseAddress(c.email) }))
    .filter(({ email }) => usable(email))
    .sort((a, b) => b.c.received + b.c.sent - (a.c.received + a.c.sent) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  for (const { c, email } of people) {
    if (!out.has(email)) out.set(email, { email, name: (c.name ?? '').trim(), source: 'email_participant' });
  }

  const meetings = new Map<string, number>();
  for (const m of summary.recurringMeetings) {
    for (const a of new Set(m.attendees.map(normaliseAddress))) {
      // Only 'automated' is dropped: a role address (team@, info@) in a meeting is usually a real person's alias.
      if (usable(a) && classifyEmailSender(a) !== 'automated') meetings.set(a, (meetings.get(a) ?? 0) + 1);
    }
  }
  const attendees = [...meetings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [email] of attendees) {
    if (!out.has(email)) out.set(email, { email, name: '', source: 'calendar_attendee' });
  }
  return [...out.values()];
}

export async function backfillContacts(
  deps: BackfillDeps,
  summary: HistorySummary,
): Promise<{ created: number; existing: number; skipped: number }> {
  const { contactService, logger } = deps;
  const all = candidatesOf(summary);
  let created = 0;
  let existing = 0;
  let skipped = 0;

  // The cap limits contacts created, not candidates looked at: on a re-run the busiest people are
  // already contacts, and must not use up the cap before anyone new is reached.
  for (const [index, { email, name, source }] of all.entries()) {
    if (created >= BACKFILL_CAP) {
      skipped += all.length - index;
      logger.info({ cap: BACKFILL_CAP, unreached: all.length - index }, 'deep-dive backfill: cap reached');
      break;
    }
    try {
      if (await contactService.resolveByChannelIdentity('email', email)) {
        existing++;
        continue;
      }
      const domain = domainOf(email);
      const { contact, kgNodeCreated } = await contactService.createContactWithKgOutcome({
        displayName: name || email,
        fallbackDisplayName: email,
        source,
        tier: 'unknown',
        primaryEmail: email,
        ...(domain !== '' && !isNonOrgDomain(domain) ? { organization: deriveOrgLabelFromDomain(domain) } : {}),
      });

      try {
        await contactService.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: email, source });
        created++;
      } catch (linkErr) {
        const pgCode = (linkErr as { code?: string }).code;
        try {
          // Retire the KG node only if this call minted it: an adopted node carries older facts (ADR-040).
          await contactService.deleteContact(contact.id, { archiveAnchoredNode: kgNodeCreated });
        } catch (deleteErr) {
          logger.warn({ deleteErr, linkErr, orphanId: contact.id }, 'deep-dive backfill: could not clean up orphaned contact after linkIdentity failure');
        }
        if (pgCode !== '23505') throw linkErr;
        // A concurrent caller linked this address first: it is already a contact.
        logger.info({ orphanId: contact.id }, 'deep-dive backfill: concurrent link conflict, orphan removed');
        skipped++;
      }
    } catch (err) {
      logger.warn({ err }, 'deep-dive backfill: skipped a candidate after an error');
      skipped++;
    }
  }
  return { created, existing, skipped };
}
