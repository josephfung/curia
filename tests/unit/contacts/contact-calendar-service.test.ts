// tests/unit/contacts/contact-calendar-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import type { Contact } from '../../../src/contacts/types.js';

describe('ContactService — calendar methods', () => {
  let service: ContactService;
  let ceoContact: Contact;

  beforeEach(async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const entityMemory = new EntityMemory(store, validator, embeddingService);
    service = ContactService.createInMemory(entityMemory);

    ceoContact = await service.createContact({
      displayName: 'Joseph Fung',
      role: 'ceo',
      source: 'test',
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
  });
});
