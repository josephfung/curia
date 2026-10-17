// What to do when a lookup comes back empty-handed (#2149).
//
// Asked for something no tool does (book a table), the coordinator kept looking: three
// more registry searches in other words, then a dozen fetches of guessed venue pages,
// most of them 404s, until the turn timed out. The guidance arrives with the dead end
// itself, in the tool result, so it costs nothing on turns that never hit one.
//
// Hard-wrapped so prompt-exfiltration marker extraction (one marker per line) covers it.
// Joined with spaces for the tool result.

/** tool-registry found nothing for a non-empty query: the capability is not there. */
export const NO_MATCHING_TOOL_NEXT_STEP_LINES: readonly string[] = [
  'No tool or skill matches this search. To be sure, list them all once with an empty query',
  'rather than rewording the search.',
  'If you were looking for a way to do something you were asked to do, take the route a person',
  'would: reach whoever can do it with the tools you have, by email or message, or offer to.',
  'Look up only what that step needs, such as their contact details, and stop once you have',
  'it. Then say plainly what you cannot do yourself, restate the request as it now stands, and',
  'say what you will do or can do next.',
];

/** web-fetch got a 404. Fetched pages carry no links, so other paths are guesses too. */
export const WEB_FETCH_NOT_FOUND_LINES: readonly string[] = [
  'HTTP 404: Not Found. Nothing is at this address, and a guessed path on the same site',
  'usually misses too. Fetch a URL from a search result, or answer with what you already have.',
];
