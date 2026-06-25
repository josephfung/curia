// tests/integration/calendar-holds-collaboration.test.ts
//
// Integration tests for calendar holds + consult-and-resume behaviours.
//
// What these tests cover that unit tests cannot:
//   1. No-table assertion: no migration file references 'hold' — guards AC #9
//   2. Config-store holds toggle round-trip: real ConfigStore/EntityMemory + KG backing
//      confirms the toggle persists, reads back, and the handler respects it end-to-end
//   3. Hold placed → self-release on booking: metadata round-trips create→list;
//      calendar-create-event invokes deleteEvent on the matching curia-hold
//   4. Bullpen source_message_id dedup: real BullpenService + Postgres confirms
//      second openThread with same sourceMessageId returns deduplicated:true
//
// Harness mirrors tests/integration/bullpen.test.ts (Pool, BullpenService.createWithPostgres)
// and tests/integration/extract-facts.test.ts (KnowledgeGraphStore, EmbeddingService,
// MemoryValidator, EntityMemory). Read those tests first if the setup looks unfamiliar.
//
// Prerequisites:
//   DATABASE_URL pointing at curia-test-pg (port 5433) must be set in env.
//   Tests skip (describe.skip) when DATABASE_URL is absent — do not hardcode it.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Memory / KG stack (same construction as extract-facts.test.ts)
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { createSilentLogger } from '../../src/logger.js';

// Bullpen (same construction as bullpen.test.ts)
import { BullpenService } from '../../src/memory/bullpen.js';

// Skill handlers under test
import { CalendarCreateHoldHandler } from '../../skills/calendar-create-hold/handler.js';
import { CalendarCreateEventHandler } from '../../skills/calendar-create-event/handler.js';

// Nylas types for mock events
import type { NylasCalendarClient, NylasCalendarEvent } from '../../src/channels/calendar/nylas-calendar-client.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { Logger } from '../../src/logger.js';
import { CURIA_HOLD_KEY, buildHoldMetadata } from '../../src/channels/calendar/holds.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Slot constants shared across hold+release tests
// ---------------------------------------------------------------------------

const SLOT_START = '2026-07-15T14:00:00Z';
const SLOT_END = '2026-07-15T15:00:00Z';
const CAL_ID = 'cal-integration-test';

// ---------------------------------------------------------------------------
// Minimal mock builders
// ---------------------------------------------------------------------------

/** Build a NylasCalendarEvent stub tagged as a curia-hold on the given slot. */
function makeHoldEvent(id: string, overrides?: Partial<NylasCalendarEvent>): NylasCalendarEvent {
  return {
    id,
    title: 'HOLD (TBC): integration test',
    description: '',
    location: '',
    startTime: Math.floor(new Date(SLOT_START).getTime() / 1000),
    endTime: Math.floor(new Date(SLOT_END).getTime() / 1000),
    startDate: null,
    endDate: null,
    participants: [],
    conferencing: null,
    status: 'tentative',
    calendarId: CAL_ID,
    busy: true,
    metadata: buildHoldMetadata({ createdAtIso: new Date().toISOString() }),
    ...overrides,
  };
}

/** Build a booked (non-hold) NylasCalendarEvent stub. */
function makeBookedEvent(id: string): NylasCalendarEvent {
  return {
    id,
    title: 'Real Meeting',
    description: '',
    location: '',
    startTime: Math.floor(new Date(SLOT_START).getTime() / 1000),
    endTime: Math.floor(new Date(SLOT_END).getTime() / 1000),
    startDate: null,
    endDate: null,
    participants: [],
    conferencing: null,
    status: 'confirmed',
    calendarId: CAL_ID,
    busy: true,
    // No curia-hold metadata — this is a real event
    metadata: null,
  };
}

/** Build a silent pino logger (suppresses all output in tests). */
function silentLog(): Logger {
  return pino({ level: 'silent' }) as unknown as Logger;
}

// ---------------------------------------------------------------------------
// Scenario 1: No-table assertion (no DB required)
// ---------------------------------------------------------------------------

describe('calendar-holds — no migration references holds (AC #9)', () => {
  it('src/db/migrations/ contains no file matching /hold/i', async () => {
    // Resolve migrations directory relative to this file's location, which is stable
    // regardless of the process CWD at test time.
    const thisFile = fileURLToPath(import.meta.url);
    // tests/integration/ → project root → src/db/migrations/
    const migrationsDir = join(thisFile, '..', '..', '..', 'src', 'db', 'migrations');
    const files = await readdir(migrationsDir);
    const holdFiles = files.filter((f) => /hold/i.test(f));
    expect(holdFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenarios 2–4: real Postgres required
// ---------------------------------------------------------------------------

describeIf('calendar-holds — config-store toggle (real Postgres)', () => {
  let pool: pg.Pool;
  let entityMemory: EntityMemory;

  // Source tag used to scope all KG nodes created in this suite so cleanup is safe.
  const SOURCE = 'integration-test-holds-toggle';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Probe the DB to fail fast if the schema is not migrated.
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');

    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, pino({ level: 'silent' }));
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Clean any stale KG nodes from a previous crashed run.
    await pool.query("DELETE FROM kg_edges WHERE source = $1", [SOURCE]);
    await pool.query("DELETE FROM kg_nodes WHERE source = $1", [SOURCE]);
  });

  afterAll(async () => {
    if (!pool) return;
    // Remove all KG nodes we wrote during these tests.
    await pool.query("DELETE FROM kg_edges WHERE source = $1", [SOURCE]);
    await pool.query("DELETE FROM kg_nodes WHERE source = $1", [SOURCE]);
    await pool.end();
  });

  it('toggle OFF: ConfigStore.set("calendar_holds","enabled","false") → handler returns held:false and createEvent is NOT called', async () => {
    const configStore = new ConfigStore(entityMemory, silentLog());
    // Write the toggle-off value into the real KG-backed store.
    await configStore.set('calendar_holds', 'enabled', 'false');

    // Verify the write actually persisted before invoking the handler.
    const readBack = await configStore.get('calendar_holds', 'enabled');
    expect(readBack).toBe('false');

    const createEvent = vi.fn();
    const ctx: SkillContext = {
      input: { calendarId: CAL_ID, start: SLOT_START, end: SLOT_END, subject: 'toggle off test' },
      secret: () => { throw new Error('no secret in integration test'); },
      log: silentLog(),
      entityMemory,
      nylasCalendarClient: { createEvent } as unknown as NylasCalendarClient,
    } as unknown as SkillContext;

    const handler = new CalendarCreateHoldHandler();
    const result = await handler.execute(ctx);

    // Handler must not call createEvent when toggle is off.
    expect(createEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.held).toBe(false);
      expect(data.holdEventId).toBeNull();
      expect(data.reason).toBe('holds disabled');
    }
  });

  it('toggle ON: after writing "true" → handler calls createEvent and returns held:true', async () => {
    // Overwrite the toggle to 'true'. ConfigStore.set is idempotent via dedup.
    const configStore = new ConfigStore(entityMemory, silentLog());
    await configStore.set('calendar_holds', 'enabled', 'true');
    // Confirm the write actually landed before invoking the handler (mirrors the
    // toggle-OFF test). Without this, a future change to the KG dedup strategy
    // could leave the stored value at 'false' and make the held:true assertion
    // fail with a confusing message instead of pointing at the real cause.
    expect(await configStore.get('calendar_holds', 'enabled')).toBe('true');

    const holdEventId = `hold-${randomUUID()}`;
    const createdHold = makeHoldEvent(holdEventId);
    const createEvent = vi.fn().mockResolvedValue(createdHold);

    const ctx: SkillContext = {
      input: { calendarId: CAL_ID, start: SLOT_START, end: SLOT_END, subject: 'toggle on test' },
      secret: () => { throw new Error('no secret in integration test'); },
      log: silentLog(),
      entityMemory,
      nylasCalendarClient: { createEvent } as unknown as NylasCalendarClient,
    } as unknown as SkillContext;

    const handler = new CalendarCreateHoldHandler();
    const result = await handler.execute(ctx);

    expect(createEvent).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.held).toBe(true);
      expect(data.holdEventId).toBe(holdEventId);
    }
  });
});

describeIf('calendar-holds — hold place → self-release (real Postgres)', () => {
  // This scenario exercises the full metadata round-trip:
  //   1. calendar-create-hold places a hold (createEvent is called, returns a hold event)
  //   2. calendar-create-event books the same slot (createEvent succeeds for the booking)
  //   3. calendar-create-event then calls listEvents → finds the hold → calls deleteEvent
  //
  // Both createEvent calls go to the same mock, so we track them by order.
  // listEvents is seeded to return the hold so self-release fires.
  // deleteEvent is tracked to confirm the hold was released.

  let pool: pg.Pool;
  let entityMemory: EntityMemory;
  const SOURCE = 'integration-test-holds-release';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');

    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, pino({ level: 'silent' }));
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    await pool.query("DELETE FROM kg_edges WHERE source = $1", [SOURCE]);
    await pool.query("DELETE FROM kg_nodes WHERE source = $1", [SOURCE]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM kg_edges WHERE source = $1", [SOURCE]);
    await pool.query("DELETE FROM kg_nodes WHERE source = $1", [SOURCE]);
    await pool.end();
  });

  it('calendar-create-event releases an overlapping curia-hold event via deleteEvent', async () => {
    const holdEventId = `hold-release-${randomUUID()}`;
    const bookedEventId = `booked-${randomUUID()}`;

    // Step 1: place the hold through the real handler (toggle unset → defaults to ON).
    // ConfigStore.get will return null (never written in this suite) → holdsEnabled = true.
    const createdHold = makeHoldEvent(holdEventId);
    const holdCreateEvent = vi.fn().mockResolvedValue(createdHold);

    const holdCtx: SkillContext = {
      input: { calendarId: CAL_ID, start: SLOT_START, end: SLOT_END, subject: 'release test hold' },
      secret: () => { throw new Error('no secret'); },
      log: silentLog(),
      entityMemory,
      nylasCalendarClient: { createEvent: holdCreateEvent } as unknown as NylasCalendarClient,
    } as unknown as SkillContext;

    const holdResult = await new CalendarCreateHoldHandler().execute(holdCtx);
    expect(holdResult.success).toBe(true);
    if (holdResult.success) {
      expect((holdResult.data as Record<string, unknown>).held).toBe(true);
      expect((holdResult.data as Record<string, unknown>).holdEventId).toBe(holdEventId);
    }

    // Confirm the hold event carries curia-hold metadata — this is what self-release looks for.
    expect(holdCreateEvent).toHaveBeenCalledOnce();
    const [, holdArgs] = holdCreateEvent.mock.calls[0]!;
    expect(holdArgs.metadata?.[CURIA_HOLD_KEY]).toBe('true');

    // Step 2: book the same slot.
    // listEvents returns the hold we placed (simulating what Nylas would return).
    // deleteEvent is the call we assert.
    const bookedEvent = makeBookedEvent(bookedEventId);
    const bookCreateEvent = vi.fn().mockResolvedValue(bookedEvent);
    const listEvents = vi.fn().mockResolvedValue([createdHold]);
    const deleteEvent = vi.fn().mockResolvedValue(undefined);

    const bookCtx: SkillContext = {
      input: {
        calendarId: CAL_ID,
        title: 'Real Meeting',
        start: SLOT_START,
        end: SLOT_END,
      },
      secret: () => { throw new Error('no secret'); },
      log: silentLog(),
      nylasCalendarClient: {
        createEvent: bookCreateEvent,
        listEvents,
        deleteEvent,
      } as unknown as NylasCalendarClient,
      // No contactService → read-only check is skipped (handled in try block)
    } as unknown as SkillContext;

    const bookResult = await new CalendarCreateEventHandler().execute(bookCtx);

    // Booking must succeed.
    expect(bookResult.success).toBe(true);
    // listEvents must have been called to find overlapping holds.
    expect(listEvents).toHaveBeenCalledOnce();
    // deleteEvent must have been called for the hold, not the booked event.
    expect(deleteEvent).toHaveBeenCalledOnce();
    const [delCalId, delEventId] = deleteEvent.mock.calls[0]!;
    expect(delCalId).toBe(CAL_ID);
    expect(delEventId).toBe(holdEventId);
  });
});

describeIf('calendar-holds — bullpen source_message_id dedup (real Postgres)', () => {
  // Mirrors bullpen.test.ts: real BullpenService + Postgres.
  // Verifies the backstop that the consult-and-resume flow relies on:
  // two openThread calls with the same sourceMessageId must be idempotent —
  // the second returns deduplicated:true and no second thread row exists.

  let pool: pg.Pool;
  let service: BullpenService;
  // Per-run prefix keeps concurrent test runs from clobbering each other.
  let runId: string;

  beforeAll(async () => {
    runId = randomUUID();
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM bullpen_threads LIMIT 0');
    const logger = createSilentLogger();
    service = BullpenService.createWithPostgres(pool, logger);
  });

  afterAll(async () => {
    if (!pool) return;
    // ON DELETE CASCADE removes bullpen_messages automatically.
    await pool.query('DELETE FROM bullpen_threads WHERE topic LIKE $1', [`${runId}%`]);
    await pool.end();
  });

  it('second openThread with the same sourceMessageId returns deduplicated:true and no extra row', async () => {
    const sourceMessageId = `msg-${runId}-dedup-test`;

    // First open — creates the thread.
    const first = await service.openThread(
      `${runId} — consult dedup test`,
      'coordinator',
      ['coordinator', 'calendar-specialist'],
      'Can you check availability for Tuesday?',
      ['calendar-specialist'],
      undefined,
      sourceMessageId,
    );
    expect(first.deduplicated).toBe(false);

    // Second open with the SAME sourceMessageId — must be a dedup hit.
    const second = await service.openThread(
      `${runId} — consult dedup test`,
      'coordinator',
      ['coordinator', 'calendar-specialist'],
      'Can you check availability for Tuesday?',
      ['calendar-specialist'],
      undefined,
      sourceMessageId,
    );
    expect(second.deduplicated).toBe(true);
    // The returned thread ID must be the same as the original.
    expect(second.thread.id).toBe(first.thread.id);

    // Confirm at the DB level: only one thread row for this sourceMessageId.
    const rows = await pool.query(
      'SELECT id FROM bullpen_threads WHERE source_message_id = $1',
      [sourceMessageId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.id).toBe(first.thread.id);
  });
});
