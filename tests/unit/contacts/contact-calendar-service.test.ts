// tests/unit/contacts/contact-calendar-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { Contact } from '../../../src/contacts/types.js';

describe('ContactService — calendar methods', () => {
  let service: ContactService;
  let ceoContact: Contact;

  beforeEach(async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
    service = ContactService.createInMemory(entityMemory);

    ceoContact = await service.createContact({
      displayName: 'Jane Doe',
      role: 'ceo',
      source: 'test',
    });
  });

  describe('principalMailboxId', () => {
    it('allows one primary per contact per mailbox and resolves the mailbox', async () => {
      const a = await service.linkCalendar({ nylasCalendarId: 'c-a', contactId: ceoContact.id, label: 'A', isPrimary: true, principalMailboxId: 'gmail' });
      await service.linkCalendar({ nylasCalendarId: 'c-b', contactId: ceoContact.id, label: 'B', isPrimary: true, principalMailboxId: 'work' });
      expect(a.principalMailboxId).toBe('gmail');
      await expect(
        service.linkCalendar({ nylasCalendarId: 'c-c', contactId: ceoContact.id, label: 'C', isPrimary: true, principalMailboxId: 'gmail' }),
      ).rejects.toThrow(/already has a primary/);
      expect((await service.resolveCalendar('c-b'))?.principalMailboxId).toBe('work');
    });

    it('defaults to no mailbox, and nylas_calendar_id stays globally unique across mailboxes', async () => {
      const cal = await service.linkCalendar({ nylasCalendarId: 'c-x', contactId: ceoContact.id, label: 'X' });
      expect(cal.principalMailboxId).toBeNull();
      await expect(
        service.linkCalendar({ nylasCalendarId: 'c-x', contactId: ceoContact.id, label: 'Y', principalMailboxId: 'work' }),
      ).rejects.toThrow(/already registered/);
    });
  });

  describe('linkCalendar', () => {
    it('links a calendar to a contact', async () => {
      const cal = await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      expect(cal.id).toBeDefined();
      expect(cal.nylasCalendarId).toBe('nylas-cal-123');
      expect(cal.contactId).toBe(ceoContact.id);
      expect(cal.label).toBe('Work');
      expect(cal.isPrimary).toBe(false);
      expect(cal.readOnly).toBe(false);
    });

    it('links a calendar with isPrimary flag', async () => {
      const cal = await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });

      expect(cal.isPrimary).toBe(true);
    });

    it('links an org-wide calendar with null contactId', async () => {
      const cal = await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-holidays',
        contactId: null,
        label: 'Company Holidays',
      });

      expect(cal.contactId).toBeNull();
      expect(cal.label).toBe('Company Holidays');
    });

    it('rejects duplicate nylas_calendar_id', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      await expect(
        service.linkCalendar({
          nylasCalendarId: 'nylas-cal-123',
          contactId: ceoContact.id,
          label: 'Duplicate',
        }),
      ).rejects.toThrow();
    });

    it('enforces at most one primary per contact', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-1',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });

      await expect(
        service.linkCalendar({
          nylasCalendarId: 'nylas-cal-2',
          contactId: ceoContact.id,
          label: 'Personal',
          isPrimary: true,
        }),
      ).rejects.toThrow();
    });

    it('rejects link to nonexistent contact', async () => {
      await expect(
        service.linkCalendar({
          nylasCalendarId: 'nylas-cal-999',
          contactId: 'nonexistent-uuid',
          label: 'Ghost',
        }),
      ).rejects.toThrow('Contact not found');
    });
  });

  describe('unlinkCalendar', () => {
    it('removes a calendar association', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      const removed = await service.unlinkCalendar('nylas-cal-123');
      expect(removed).toBe(true);

      const calendars = await service.getCalendarsForContact(ceoContact.id);
      expect(calendars).toHaveLength(0);
    });

    it('returns false for unknown calendar ID', async () => {
      const removed = await service.unlinkCalendar('nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('getCalendarsForContact', () => {
    it('returns all calendars for a contact', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-work',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-personal',
        contactId: ceoContact.id,
        label: 'Personal',
      });

      const calendars = await service.getCalendarsForContact(ceoContact.id);
      expect(calendars).toHaveLength(2);
      expect(calendars.map(c => c.label).sort()).toEqual(['Personal', 'Work']);
    });

    it('returns empty array for contact with no calendars', async () => {
      const calendars = await service.getCalendarsForContact(ceoContact.id);
      expect(calendars).toHaveLength(0);
    });
  });

  describe('resolveCalendar', () => {
    it('returns the contact for a registered calendar', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      const result = await service.resolveCalendar('nylas-cal-123');
      expect(result).toBeDefined();
      expect(result!.contactId).toBe(ceoContact.id);
      expect(result!.label).toBe('Work');
    });

    it('returns null for unregistered calendar', async () => {
      const result = await service.resolveCalendar('unknown-cal');
      expect(result).toBeNull();
    });

    it('returns null contactId for org-wide calendar', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-holidays',
        contactId: null,
        label: 'Company Holidays',
      });

      const result = await service.resolveCalendar('nylas-cal-holidays');
      expect(result).toBeDefined();
      expect(result!.contactId).toBeNull();
      expect(result!.label).toBe('Company Holidays');
    });
  });

  describe('getPrimaryCalendar', () => {
    it('returns the primary calendar for a contact', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-secondary',
        contactId: ceoContact.id,
        label: 'Personal',
      });
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-primary',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });

      const primary = await service.getPrimaryCalendar(ceoContact.id);
      expect(primary).toBeDefined();
      expect(primary!.nylasCalendarId).toBe('nylas-cal-primary');
      expect(primary!.label).toBe('Work');
    });

    it('returns null when no primary is set', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      const primary = await service.getPrimaryCalendar(ceoContact.id);
      expect(primary).toBeNull();
    });

    it('with a mailbox, returns that mailbox\'s primary; without, the oldest, every time (#2475)', async () => {
      await service.linkCalendar({ nylasCalendarId: 'c-work', contactId: ceoContact.id, label: 'W', isPrimary: true, principalMailboxId: 'work' });
      await new Promise((r) => setTimeout(r, 2));
      await service.linkCalendar({ nylasCalendarId: 'c-personal', contactId: ceoContact.id, label: 'P', isPrimary: true, principalMailboxId: 'personal' });
      expect((await service.getPrimaryCalendar(ceoContact.id, 'personal'))?.nylasCalendarId).toBe('c-personal');
      expect((await service.getPrimaryCalendar(ceoContact.id, 'work'))?.nylasCalendarId).toBe('c-work');
      expect(await service.getPrimaryCalendar(ceoContact.id, 'other')).toBeNull();
      for (let i = 0; i < 3; i++) {
        expect((await service.getPrimaryCalendar(ceoContact.id))?.nylasCalendarId).toBe('c-work');
      }
    });
  });

  describe('mailbox reads and moves (#2475)', () => {
    it('getCalendarsForMailbox lists any contact\'s calendars in that mailbox', async () => {
      const other = await service.createContact({ displayName: 'Shared Owner', source: 'test' });
      await service.linkCalendar({ nylasCalendarId: 'c1', contactId: ceoContact.id, label: 'A', principalMailboxId: 'work' });
      await service.linkCalendar({ nylasCalendarId: 'c2', contactId: other.id, label: 'B', principalMailboxId: 'work' });
      await service.linkCalendar({ nylasCalendarId: 'c3', contactId: ceoContact.id, label: 'C', principalMailboxId: 'personal' });
      expect((await service.getCalendarsForMailbox('work')).map((c) => c.nylasCalendarId).sort()).toEqual(['c1', 'c2']);
    });

    it('setCalendarMailbox moves a calendar, refusing a second primary in the target mailbox', async () => {
      await service.linkCalendar({ nylasCalendarId: 'home-w', contactId: ceoContact.id, label: 'W', isPrimary: true, principalMailboxId: 'work' });
      await service.linkCalendar({ nylasCalendarId: 'home-p', contactId: ceoContact.id, label: 'P', isPrimary: true, principalMailboxId: 'personal' });
      await service.linkCalendar({ nylasCalendarId: 'plain', contactId: ceoContact.id, label: 'X', principalMailboxId: 'work' });
      expect(await service.setCalendarMailbox('plain', 'personal')).toBe(true);
      expect((await service.resolveCalendar('plain'))?.principalMailboxId).toBe('personal');
      await expect(service.setCalendarMailbox('home-w', 'personal')).rejects.toMatchObject({ code: '23505' });
      expect(await service.setCalendarMailbox('missing', 'personal')).toBe(false);
    });
  });

  describe('merge with calendars in several mailboxes (#2475)', () => {
    it('keeps primaries in two mailboxes and demotes one in the same mailbox', async () => {
      const secondary = await service.createContact({ displayName: 'Jane D', source: 'test' });
      await service.linkCalendar({ nylasCalendarId: 's-a', contactId: ceoContact.id, label: 'A', isPrimary: true, principalMailboxId: 'work' });
      await service.linkCalendar({ nylasCalendarId: 'm-b', contactId: secondary.id, label: 'B', isPrimary: true, principalMailboxId: 'personal' });
      await service.linkCalendar({ nylasCalendarId: 'm-a', contactId: secondary.id, label: 'A2', isPrimary: true, principalMailboxId: 'work' });
      await service.mergeContacts(ceoContact.id, secondary.id);
      const byId = Object.fromEntries((await service.getCalendarsForContact(ceoContact.id)).map((c) => [c.nylasCalendarId, c.isPrimary]));
      expect(byId).toEqual({ 's-a': true, 'm-b': true, 'm-a': false });
    });
  });
});
