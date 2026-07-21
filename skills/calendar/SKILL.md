---
name: calendar
description: >
  Google Calendar tools for listing calendars/events, creating and updating events,
  finding free time, checking conflicts, RSVPs, and tentative holds. Per-tool
  action_risk is preserved (list/find/check = none; create-hold/RSVP = medium;
  holds-sweep = low; create/update/delete/register = high).
version: "0.1.1"
tools:
  - calendar-list-calendars
  - calendar-register
  - calendar-list-events
  - calendar-create-event
  - calendar-update-event
  - calendar-delete-event
  - calendar-respond-to-invite
  - calendar-find-free-time
  - calendar-check-conflicts
  - calendar-create-hold
  - calendar-holds-sweep
---
