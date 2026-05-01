# Autonomy Web UI — Design Spec

**Issue:** #409
**Date:** 2026-05-01

## Summary

Add a dedicated "Autonomy" settings page to the web UI, allowing the CEO to view
and adjust the autonomy score without switching to the CLI. The page displays the
current score/band, provides a slider control for adjustment, and shows paginated
change history.

## Motivation

As autonomy gates become enforcement-backed (Phase 2, #147), the CEO needs fast,
accessible score adjustment. The web UI is the natural place — it's already open
during work and avoids context-switching to the CLI.

## Architecture Decision

**Approach: New REST endpoints** (over skill-proxy or SSE push).

REST endpoints follow the established identity/executive route pattern. The UI
calls these directly with session-cookie auth. This is consistent, testable, and
minimal new code. The alternative (proxying through the chat/skill layer) would be
fragile and slow; real-time SSE push is over-engineered for a setting that changes
infrequently.

## Backend: REST API

New route file: `src/channels/http/routes/autonomy.ts`

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/autonomy` | Current config |
| PUT | `/api/autonomy` | Set score |
| GET | `/api/autonomy/history` | Paginated history |

### GET /api/autonomy

**Response 200:**
```json
{
  "autonomy": {
    "score": 75,
    "band": "approval-required",
    "bandDescription": "Present plan & ask for confirmation before consequential actions.",
    "updatedAt": "2026-05-01T14:30:00Z",
    "updatedBy": "web-ui"
  }
}
```

Returns `null` for `autonomy` if migration 011 has not been run (matches
`AutonomyService.getConfig()` behavior).

### PUT /api/autonomy

**Request body:**
```json
{
  "score": 82,
  "reason": "Increasing trust after successful week"
}
```

- `score` (required): integer 0-100
- `reason` (optional): string explaining the change

Sets via `AutonomyService.setScore(score, 'web-ui', reason)`.

**Response 200:**
```json
{
  "autonomy": {
    "score": 82,
    "band": "spot-check",
    "bandDescription": "Proceed on routine tasks, note consequential actions for visibility.",
    "updatedAt": "2026-05-01T14:35:00Z",
    "updatedBy": "web-ui"
  },
  "previousScore": 75,
  "updated": true
}
```

**Response 400:** Validation error (score out of range, not an integer).

### GET /api/autonomy/history

**Query params:**
- `limit` (optional, default 5, max 50)
- `offset` (optional, default 0)

**Response 200:**
```json
{
  "history": [
    {
      "id": "uuid",
      "score": 82,
      "previousScore": 75,
      "band": "spot-check",
      "changedBy": "web-ui",
      "reason": "Increasing trust after successful week",
      "changedAt": "2026-05-01T14:35:00Z"
    }
  ],
  "total": 12
}
```

The `total` field enables the UI to know whether "Show more" should be visible.

### Authentication

Same session-cookie pattern as identity/executive routes. Add `/api/autonomy*` to
the auth-skip list in `http-adapter.ts` (session auth is handled inside the route
via `assertSecret`, not the global bearer hook).

### Service Extension

`AutonomyService.getHistory(limit)` currently only accepts a `limit` parameter.
The history endpoint requires pagination support. Add an `offset` parameter and
a `getHistoryCount()` method (or return `{ rows, total }`) to support the
paginated API. This is a small, backward-compatible addition — the existing
`limit`-only call sites continue to work with `offset` defaulting to 0.

### Registration

Register in `http-adapter.ts` alongside the other settings routes. Pass
`autonomyService` instance from the bootstrap.

## Frontend: Autonomy Settings View

### Navigation

Add "Autonomy" as a sub-item under the Settings nav group in the sidebar, below
"Setup Wizard". Uses the same `nav-sub-item` class and `navigate()` pattern.

### View: `#view-autonomy`

Layout (top to bottom):

#### 1. Page heading

"Autonomy" — Lora serif heading, consistent with other view titles.

#### 2. Current state display

- **Score** — large numeric display (e.g., 2rem font-weight 700)
- **Band label** — badge using existing `.badge` styling, color-coded by band
- **Band description** — muted text below, showing the behavioral description

#### 3. Score adjustment control

- Range input: `<input type="range" min="0" max="100" step="1">`
  - Styled with `accent-color: var(--primary)` (matches wizard sliders)
  - `.slider-labels` div: "Restricted" (left) / "Full" (right)
- Real-time preview: as the slider moves, the score number, band label, and
  description update immediately (before save). This is purely client-side —
  uses `AutonomyService.bandForScore()` logic replicated in JS.
- Reason textarea: optional, placeholder "Reason for change (optional)"
- Save button: `.btn-primary`, disabled until slider value differs from the
  currently saved score. On click: PUT `/api/autonomy`.

#### 4. History section

- Heading: "Recent changes"
- List of history entries, each showing:
  - Score change: "75 → 82" (with arrow)
  - Band label (badge)
  - Changed by + relative timestamp (e.g., "web-ui · 2 hours ago")
  - Reason (if present, muted italic text)
- "Show more" button at bottom: loads next 5 entries (offset += 5), appends to
  list. Hidden when `offset + currentEntries.length >= total`.

### Behavior

- **On view load:** Parallel fetch of GET `/api/autonomy` and
  GET `/api/autonomy/history?limit=5&offset=0`.
- **On save:** PUT `/api/autonomy` with slider value + reason. On success:
  update the state display with the response, prepend a new entry to the history
  list, clear the reason field, disable the save button.
- **Slider interaction:** `oninput` updates the preview. The save button enables
  only when the slider value differs from the last-saved score.

### Band-to-color mapping

| Band | Color (reusing existing palette) |
|------|------|
| full | #5E9E6B (green — same as Event type) |
| spot-check | #6BAED6 (blue — same as Organization type) |
| approval-required | #C9874A (amber — same as Decision type) |
| draft-only | #7E6BA8 (purple — same as Project type) |
| restricted | #E86040 (red — same as Restricted sensitivity) |

### Client-side band logic

Replicate the band boundaries in the frontend JS to avoid a round-trip on every
slider tick:

```javascript
function bandForScore(score) {
  if (score >= 90) return { band: 'full', label: 'Full' };
  if (score >= 80) return { band: 'spot-check', label: 'Spot-check' };
  if (score >= 70) return { band: 'approval-required', label: 'Approval Required' };
  if (score >= 60) return { band: 'draft-only', label: 'Draft Only' };
  return { band: 'restricted', label: 'Restricted' };
}
```

Band descriptions are also replicated client-side (5 static strings from
`AutonomyService.bandDescription()`).

## Testing

- **Backend integration tests:** Test all 3 endpoints (happy path + validation
  errors + auth rejection). Follow existing patterns in the identity/executive
  route tests.
- **Frontend:** Manual verification via the dev server. Confirm slider updates
  preview, save persists and updates history, "Show more" paginates correctly.

## Out of scope

- Real-time sync between web UI and CLI changes (not needed — page load fetches
  fresh data)
- Undo/revert button (history is visible; user can manually set back)
- Autonomy auto-adjustment logic (that's Phase 3, separate work)
