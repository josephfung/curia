// skills/diagnostics/tools/resolve-time-window/handler.ts
//
// Resolve a fuzzy natural-language time reference into a concrete ISO time
// window for audit-query (#1592). Uses chrono-node for NL parsing and luxon for
// timezone-correct, DST-aware ISO formatting against ctx.timezone.
//
// Pure computation. No external services, no side effects.

import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';

/** Same shape audit-query requires for since/until. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const DEFAULT_WINDOW_MINUTES = 30;

const SUPPORTED_FORMS =
  'Supported forms: point-in-time ("around 11:44am", "8:01am today"), ' +
  'explicit ranges ("8-9am yesterday"), whole days ("yesterday", "last Tuesday"), ' +
  'and recent relative windows ("last 2 hours", "past 30 minutes").';

function toAuditIso(dt: DateTime): string {
  // Prefer seconds + offset without fractional ms so the string stays tidy while
  // still matching audit-query's ISO_DATETIME_RE.
  const iso = dt.set({ millisecond: 0 }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
  if (!ISO_DATETIME_RE.test(iso)) {
    // Defensive fallback — luxon's toISO always includes offset for zoned DateTimes.
    const fallback = dt.toISO();
    if (!fallback || !ISO_DATETIME_RE.test(fallback)) {
      throw new Error(`resolve-time-window: failed to format ISO datetime for ${dt.toString()}`);
    }
    return fallback;
  }
  return iso;
}

/**
 * Build a luxon DateTime from chrono components in the caller's IANA zone.
 * Prefer component wall-clock values over chrono's JS Date — that Date is
 * timezone-offset sensitive and can mis-handle DST transitions.
 */
function componentsToDateTime(components: chrono.ParsedComponents, zone: string): DateTime {
  const year = components.get('year');
  const month = components.get('month');
  const day = components.get('day');
  if (year === null || month === null || day === null) {
    throw new Error('resolve-time-window: chrono result missing year/month/day');
  }
  return DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: components.get('hour') ?? 0,
      minute: components.get('minute') ?? 0,
      second: components.get('second') ?? 0,
      millisecond: 0,
    },
    { zone },
  );
}

function formatInterpretation(since: DateTime, until: DateTime): string {
  const abbr = since.toFormat('ZZZZ');
  if (since.hasSame(until, 'day')) {
    return `${since.toFormat('h:mm a')} to ${until.toFormat('h:mm a')} ${abbr}, ${since.toFormat('MMM d')}`;
  }
  return `${since.toFormat('h:mm a MMM d')} to ${until.toFormat('h:mm a MMM d')} ${abbr}`;
}

/** True when the expression names a backward-looking duration ending at "now". */
function isRecentRelativeWindow(expression: string, result: chrono.ParsedResult): boolean {
  if (!/^\s*(last|past)\b/i.test(expression)) return false;
  // Chrono tags relative duration parses (e.g. "last 2 hours") this way.
  return result.start.tags().has('result/relativeDateAndTime');
}

export class ResolveTimeWindowHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = (ctx.input ?? {}) as Record<string, unknown>;
    const expression = typeof input.expression === 'string' ? input.expression.trim() : '';

    if (!expression) {
      return {
        success: false,
        error: `Provide 'expression' (a natural-language time reference). ${SUPPORTED_FORMS}`,
      };
    }

    let windowMinutes = DEFAULT_WINDOW_MINUTES;
    if (input.default_window_minutes !== undefined) {
      if (
        typeof input.default_window_minutes !== 'number' ||
        !Number.isFinite(input.default_window_minutes) ||
        input.default_window_minutes <= 0
      ) {
        return {
          success: false,
          error: 'default_window_minutes must be a positive number',
        };
      }
      windowMinutes = input.default_window_minutes;
    }

    const timezone = ctx.timezone ?? 'UTC';
    const now = DateTime.now().setZone(timezone);
    if (!now.isValid) {
      return { success: false, error: `Invalid timezone: "${timezone}"` };
    }

    let results: chrono.ParsedResult[];
    try {
      results = chrono.parse(expression, {
        instant: now.toJSDate(),
        timezone: now.offset,
      });
    } catch (err) {
      ctx.log.error({ err, expression }, 'resolve-time-window: chrono parse threw');
      return {
        success: false,
        error: `Could not parse time expression: "${expression}". ${SUPPORTED_FORMS}`,
      };
    }

    const parsed = results[0];
    if (!parsed) {
      return {
        success: false,
        error: `Could not parse time expression: "${expression}". ${SUPPORTED_FORMS}`,
      };
    }

    let since: DateTime;
    let until: DateTime;

    try {
      if (parsed.end) {
        // Explicit range ("8-9am yesterday") — use the stated bounds.
        since = componentsToDateTime(parsed.start, timezone);
        until = componentsToDateTime(parsed.end, timezone);
      } else if (parsed.start.isCertain('hour')) {
        const center = componentsToDateTime(parsed.start, timezone);
        if (isRecentRelativeWindow(expression, parsed) && center < now) {
          // "last 2 hours" / "past 30 minutes" → [then, now].
          since = center;
          until = now.set({ millisecond: 0 });
        } else {
          // Point-in-time → center ± windowMinutes.
          since = center.minus({ minutes: windowMinutes });
          until = center.plus({ minutes: windowMinutes });
        }
      } else {
        // Date-only / whole-day ("yesterday", "last Tuesday") — start..end of day.
        const day = componentsToDateTime(parsed.start, timezone).startOf('day');
        since = day;
        // 23:59:59 local — keeps seconds clean for audit-query's regex.
        until = day.plus({ days: 1 }).minus({ seconds: 1 });
      }
    } catch (err) {
      ctx.log.error({ err, expression }, 'resolve-time-window: failed to build window');
      return {
        success: false,
        error: `Could not resolve time expression: "${expression}". ${SUPPORTED_FORMS}`,
      };
    }

    if (!since.isValid || !until.isValid) {
      return {
        success: false,
        error: `Could not resolve time expression: "${expression}". ${SUPPORTED_FORMS}`,
      };
    }

    if (until <= since) {
      return {
        success: false,
        error: `Resolved window is empty or inverted for "${expression}" (since >= until). Try a more specific expression.`,
      };
    }

    let sinceIso: string;
    let untilIso: string;
    try {
      sinceIso = toAuditIso(since);
      untilIso = toAuditIso(until);
    } catch (err) {
      ctx.log.error({ err, expression }, 'resolve-time-window: ISO format failed');
      return {
        success: false,
        error: `Could not format timestamps for "${expression}". ${SUPPORTED_FORMS}`,
      };
    }

    const interpretation = formatInterpretation(since, until);
    const displayTimezone = ctx.timezone
      ? formatDisplayTimezone(ctx.timezone, since.toJSDate())
      : null;

    ctx.log.info(
      { expression, since: sinceIso, until: untilIso, interpretation },
      'resolve-time-window: resolved',
    );

    return {
      success: true,
      data: {
        since: sinceIso,
        until: untilIso,
        interpretation,
        displayTimezone,
      },
    };
  }
}
