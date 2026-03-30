// handler.ts — context-for-email skill implementation.
//
// Assembles complete context for composing an email in a single call.
// Bridges the gap between siloed knowledge and the LLM's need for complete
// context in one response. Instead of the LLM making 4-5 sequential tool
// calls (template policy + contact lookup + meeting link + etc.), this skill
// gathers everything relevant in one call.
//
// This is an infrastructure skill because it needs:
//   - entityMemory (to resolve email policies and meeting links from KG)
//   - contactService (to look up recipient contact info)

import type { SkillHandler, SkillContext, SkillResult, AgentPersona } from '../../src/skills/types.js';
import { resolveSignature, resolvePolicy } from '../_shared/template-base.js';

// Map email_type input values to KG template labels
const TYPE_TO_LABEL: Record<string, string> = {
  'meeting-request': 'template:meeting-request',
  'reschedule': 'template:reschedule',
  'cancel': 'template:cancel',
  'doc-request': 'template:doc-request',
};

// Default policies for each email type — imported inline to avoid circular deps.
// These are the same defaults defined in each template skill handler.
// TODO: extract default policies into a shared constants file to avoid this duplication.
const DEFAULT_POLICIES: Record<string, unknown> = {
  'meeting-request': {
    required_elements: [
      'Greeting addressing the recipient by name',
      'State who is requesting the meeting and the purpose',
      'List proposed times as bullet points',
      'Include duration and location if provided',
      'Offer flexibility for alternative times',
      'Professional sign-off with the agent signature',
    ],
    tone: 'Professional, warm, and concise.',
    structure: 'Greeting → purpose → proposed times → logistics → flexibility offer → sign-off',
    constraints: ['Keep to 4-6 sentences plus time list', 'No exclamation marks', 'Subject includes meeting purpose'],
  },
  'reschedule': {
    required_elements: [
      'Greeting addressing the recipient by name',
      'Reference the original meeting time',
      'Brief reason for rescheduling if provided',
      'List new proposed times as bullet points',
      'Invite alternatives',
      'Brief apology',
      'Professional sign-off',
    ],
    tone: 'Apologetic but confident.',
    structure: 'Greeting → reference original → reason → new times → flexibility → apology → sign-off',
    constraints: ['Keep to 4-6 sentences plus time list', 'Subject includes "Rescheduling"', 'Do not blame anyone'],
  },
  'cancel': {
    required_elements: [
      'Greeting addressing the recipient by name',
      'Reference the specific meeting being canceled',
      'Brief reason if provided',
      'Offer to reschedule unless told not to',
      'Thanks for understanding',
      'Professional sign-off',
    ],
    tone: 'Respectful and direct.',
    structure: 'Greeting → identify meeting → cancellation → reason → reschedule offer → thanks → sign-off',
    constraints: ['Keep to 3-5 sentences', 'Subject includes "Cancellation"', 'One apology max'],
  },
  'doc-request': {
    required_elements: [
      'Greeting addressing the recipient by name',
      'Reference upcoming meeting',
      'Purpose — helping sender prepare',
      'List requested documents as bullet points',
      'Deadline if provided',
      'Offer to clarify',
      'Professional sign-off',
    ],
    tone: 'Polite and helpful. Frame as enabling a productive meeting.',
    structure: 'Greeting → meeting reference → purpose → document list → deadline → clarify offer → sign-off',
    constraints: ['Keep to 4-6 sentences plus materials list', 'Subject includes "Materials Needed"', 'Polite deadline framing'],
  },
};

const MEETING_LINKS_LABEL = 'meeting-links';

export class ContextForEmailHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { email_type, recipient_name } = ctx.input as {
      email_type?: string;
      recipient_name?: string;
    };

    if (!email_type || !TYPE_TO_LABEL[email_type]) {
      return { success: false, error: `Missing or invalid email_type — must be one of: ${Object.keys(TYPE_TO_LABEL).join(', ')}` };
    }
    if (!recipient_name || typeof recipient_name !== 'string') {
      return { success: false, error: 'Missing required input: recipient_name' };
    }
    if (recipient_name.length > 500) {
      return { success: false, error: 'recipient_name must be 500 characters or fewer' };
    }

    const templateLabel = TYPE_TO_LABEL[email_type]!;
    const defaultPolicy = DEFAULT_POLICIES[email_type]!;

    // Gather all context in parallel where possible
    const [policyResult, recipientResult, meetingLinkResult] = await Promise.all([
      // 1. Email composing guidelines (policy + refinements)
      resolvePolicy(ctx, templateLabel, defaultPolicy),
      // 2. Recipient contact info (if contact service is available)
      this.lookupRecipient(ctx, recipient_name),
      // 3. Recipient's meeting link (if on file in KG)
      this.lookupMeetingLink(ctx, recipient_name),
    ]);

    // Assemble the recipient object
    const recipient: Record<string, unknown> = {};
    if (recipientResult) {
      recipient.display_name = recipientResult.displayName;
      if (recipientResult.role) recipient.role = recipientResult.role;
      if (recipientResult.email) recipient.email = recipientResult.email;
    }
    if (meetingLinkResult) {
      recipient.meeting_link = meetingLinkResult;
    }

    const agentSignature = resolveSignature(ctx.agentPersona);

    ctx.log.info(
      { email_type, recipient_name, policySource: policyResult.source, hasContact: !!recipientResult, hasMeetingLink: !!meetingLinkResult },
      'Assembled email context',
    );

    return {
      success: true,
      data: {
        guidelines: policyResult.policy,
        guidelines_source: policyResult.source,
        recipient: Object.keys(recipient).length > 0 ? recipient : null,
        agent_signature: agentSignature,
        instructions: `Use the guidelines to compose a ${email_type} email. The recipient field contains any known contact info and meeting link — use it naturally in the email (e.g., include their meeting link if scheduling a video call). If refinements are present in the guidelines, apply them. Adapt naturally — do not copy any example verbatim.`,
      },
    };
  }

  /**
   * Look up recipient contact info via the contact service.
   * Uses findContactByName for partial name matching, then fetches
   * identities to find their email address.
   * Returns null if not found or contact service is unavailable.
   */
  private async lookupRecipient(
    ctx: SkillContext,
    recipientName: string,
  ): Promise<{ displayName: string; role?: string; email?: string } | null> {
    if (!ctx.contactService) return null;

    try {
      const contacts = await ctx.contactService.findContactByName(recipientName);
      if (contacts.length === 0) return null;

      const contact = contacts[0]!;
      // Fetch identities to find their email address
      const withIdentities = await ctx.contactService.getContactWithIdentities(contact.id);
      let email: string | undefined;
      if (withIdentities) {
        const emailIdentity = withIdentities.identities.find(
          (id) => id.channel === 'email',
        );
        if (emailIdentity) email = emailIdentity.channelIdentifier;
      }

      return {
        displayName: contact.displayName,
        role: contact.role ?? undefined,
        email,
      };
    } catch (err) {
      // Contact lookup failure is non-fatal — we just won't have contact info
      ctx.log.debug({ err, recipientName }, 'Contact lookup failed during context assembly');
      return null;
    }
  }

  /**
   * Look up the recipient's meeting link from the knowledge graph.
   * Returns the link string if found, null otherwise.
   */
  private async lookupMeetingLink(
    ctx: SkillContext,
    recipientName: string,
  ): Promise<string | null> {
    if (!ctx.entityMemory) return null;

    try {
      const nodes = await ctx.entityMemory.findEntities(MEETING_LINKS_LABEL);
      if (nodes.length === 0) return null;

      // Search across all meeting-links anchors for a matching person name
      const allFacts = await Promise.all(nodes.map((n) => ctx.entityMemory!.getFacts(n.id)));
      const lowerName = recipientName.toLowerCase();

      for (const fact of allFacts.flat()) {
        const personName = fact.properties.person_name;
        if (typeof personName === 'string' && personName.toLowerCase().includes(lowerName)) {
          const link = fact.properties.link;
          if (typeof link === 'string') return link;
        }
      }

      return null;
    } catch (err) {
      ctx.log.debug({ err, recipientName }, 'Meeting link lookup failed during context assembly');
      return null;
    }
  }
}
