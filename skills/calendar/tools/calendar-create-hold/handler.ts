// skills/calendar-create-hold/handler.ts
//
// calendar-create-hold -- places a tentative busy HOLD (TBC) on a calendar slot
// while an offer is outstanding. The hold has no attendees so no invitations are
// sent, and it is tagged with curia-hold metadata so the holds-sweep can expire
// it automatically if the slot is never booked.
//
// Design decisions from the brief (calendar-holds spec §Layer 2 + §Autonomy):
//   - action_risk: medium (min score 70) -- lower than calendar-create-event (high/80)
//     because: no invitees, no notifications, reversible, auto-expires.
//   - Hold failures are NON-FATAL: a createEvent error returns success:true with
//     held:false so the caller's draft/offer still goes out.
//   - Toggle OFF path: if calendar_holds:enabled === 'false' in ConfigStore, skip
//     createEvent entirely and return held:false, reason:'holds disabled'.
//   - Default ON: null (never set) and 'true' are both treated as enabled.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';
import { buildHoldMetadata } from '../../../../src/channels/calendar/holds.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

// The namespace / key where the holds toggle lives in the config store.
const HOLDS_NAMESPACE = 'calendar_holds';
const HOLDS_KEY = 'enabled';

export class CalendarCreateHoldHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    // Guard: Nylas calendar client is required.
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured -- Nylas credentials missing' };
    }

    // Extract and validate inputs.
    const { calendarId, start, end, subject, sourceRef, threadRef, contactId, contactDomain } = ctx.input as {
      calendarId?: string;
      start?: string;
      end?: string;
      subject?: string;
      sourceRef?: string;
      threadRef?: string;
      contactId?: string;
      contactDomain?: string;
    };

    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!start || typeof start !== 'string') {
      return { success: false, error: 'Missing required input: start' };
    }
    if (!end || typeof end !== 'string') {
      return { success: false, error: 'Missing required input: end' };
    }
    // Validate that both timestamps are parseable.
    if (isNaN(new Date(start).getTime())) {
      return { success: false, error: 'Invalid input: start is not a valid date' };
    }
    if (isNaN(new Date(end).getTime())) {
      return { success: false, error: 'Invalid input: end is not a valid date' };
    }
    // End must be strictly after start -- a zero-duration hold makes no sense.
    if (new Date(end) <= new Date(start)) {
      return { success: false, error: 'Invalid input: end must be after start' };
    }

    // Build the display string early so we can return it even on toggle-off / error paths.
    // toLocalIso converts Unix seconds to the user's timezone; formatDisplayTimezone labels it.
    const tz = ctx.timezone;
    const startUnix = Math.floor(new Date(start).getTime() / 1000);
    const endUnix = Math.floor(new Date(end).getTime() / 1000);
    // toLocalIso / formatDisplayTimezone throw on a malformed timezone. Guard them
    // so a bad ctx.timezone degrades to raw values rather than making the skill throw
    // (skills must return a ToolResult, never reject).
    let displayStart = start;
    let displayEnd = end;
    let tzLabel = 'UTC';
    try {
      displayStart = toLocalIso(startUnix, tz) ?? start;
      displayEnd = toLocalIso(endUnix, tz) ?? end;
      tzLabel = tz ? formatDisplayTimezone(tz, new Date()) : 'UTC';
    } catch (err) {
      ctx.log.warn({ err, tz }, 'calendar-create-hold: timezone formatting failed -- falling back to raw values');
    }
    // Format: "2026-06-25T10:30:00-04:00 -- 11:30:00-04:00 (EDT (UTC-04:00))"
    // This gives the LLM enough context to describe the slot to the user in natural language.
    const display = `${displayStart} -- ${displayEnd} (${tzLabel})`;

    // -- Toggle check --
    // Read the calendar_holds:enabled flag from the config store (KG-backed kv store).
    // ConfigStore.get() returns null when the key has never been written.
    // Default ON: null -> enabled, 'true' -> enabled, 'false' -> disabled.
    let holdsEnabled = true;
    if (ctx.entityMemory) {
      try {
        const store = new ConfigStore(ctx.entityMemory, ctx.log);
        const toggleValue = await store.get(HOLDS_NAMESPACE, HOLDS_KEY);
        // Only disable when explicitly set to the string 'false'.
        if (toggleValue === 'false') {
          holdsEnabled = false;
        }
      } catch (err) {
        // Config store read failure is non-fatal: proceed as if enabled.
        // Failing open (holding) is safer than failing closed (not holding).
        ctx.log.warn({ err }, 'calendar-create-hold: ConfigStore read failed -- proceeding with holds enabled');
      }
    }

    if (!holdsEnabled) {
      // Toggle is off -- return early without placing a hold.
      ctx.log.info({ calendarId }, 'calendar-create-hold: holds disabled by toggle');
      return {
        success: true,
        data: {
          held: false,
          holdEventId: null,
          display,
          displayTimezone: tzLabel,
          reason: 'holds disabled',
        },
      };
    }

    // -- Place the hold --
    // Build metadata tagging this event as a Curia hold.
    const metadata = buildHoldMetadata({
      createdAtIso: new Date().toISOString(),
      sourceRef,
      threadRef,
      subject,
      contactId,
      contactDomain,
    });

    // Hold title: always prefixed with 'HOLD (TBC):' so it's visually obvious on
    // the calendar that this is a provisional block, not a real commitment.
    const holdTitle = `HOLD (TBC): ${subject ?? 'tentative'}`;

    try {
      const event = await ctx.nylasCalendarClient.createEvent(calendarId, {
        title: holdTitle,
        start,
        end,
        busy: true,
        status: 'tentative',
        // Explicitly no attendees -- this prevents Nylas from sending invitations.
        // A hold is internal only; the invitee will get a real invite if the slot is accepted.
        metadata,
      });

      ctx.log.info({ calendarId, holdEventId: event.id, subject }, 'calendar-create-hold: placed hold');

      return {
        success: true,
        data: {
          held: true,
          holdEventId: event.id,
          display,
          displayTimezone: tzLabel,
        },
      };
    } catch (err) {
      // Hold failure must never break the caller's draft/offer workflow.
      // Return success:true with held:false so the caller still proceeds.
      const reason = err instanceof Error ? err.message : String(err);
      ctx.log.error(
        { err, calendarId, subject },
        'calendar-create-hold: failed to place hold -- proceeding without hold',
      );
      return {
        success: true,
        data: {
          held: false,
          holdEventId: null,
          display,
          displayTimezone: tzLabel,
          reason,
        },
      };
    }
  }
}
