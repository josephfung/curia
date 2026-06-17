// src/contacts/email-sender-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyEmailSender } from './contact-service.js';

describe('classifyEmailSender', () => {
  // Personal webmail domains → always person
  it('classifies gmail addresses as person', () => {
    expect(classifyEmailSender('john@gmail.com')).toBe('person');
    expect(classifyEmailSender('alice.smith@googlemail.com')).toBe('person');
  });

  it('classifies common webmail domains as person', () => {
    expect(classifyEmailSender('user@yahoo.com')).toBe('person');
    expect(classifyEmailSender('user@hotmail.com')).toBe('person');
    expect(classifyEmailSender('user@outlook.com')).toBe('person');
    expect(classifyEmailSender('user@icloud.com')).toBe('person');
    expect(classifyEmailSender('user@protonmail.com')).toBe('person');
    expect(classifyEmailSender('user@live.com')).toBe('person');
  });

  // Non-person local parts → organization
  it('classifies noreply addresses as organization', () => {
    expect(classifyEmailSender('noreply@github.com')).toBe('organization');
    expect(classifyEmailSender('no-reply@stripe.com')).toBe('organization');
    expect(classifyEmailSender('no_reply@acme.com')).toBe('organization');
  });

  it('classifies system role local parts as organization', () => {
    expect(classifyEmailSender('notifications@github.com')).toBe('organization');
    expect(classifyEmailSender('info@startup.io')).toBe('organization');
    expect(classifyEmailSender('support@cloudflare.com')).toBe('organization');
    expect(classifyEmailSender('admin@company.com')).toBe('organization');
    expect(classifyEmailSender('billing@shopify.com')).toBe('organization');
    expect(classifyEmailSender('team@acme.com')).toBe('organization');
    expect(classifyEmailSender('alerts@monitoring.io')).toBe('organization');
    expect(classifyEmailSender('newsletter@substack.com')).toBe('organization');
    expect(classifyEmailSender('mailer-daemon@googlemail.com')).toBe('person'); // personal domain wins
    expect(classifyEmailSender('mailer-daemon@mailserver.example')).toBe('organization');
  });

  // Personal name patterns → person
  it('classifies first.last patterns as person', () => {
    expect(classifyEmailSender('john.doe@company.com')).toBe('person');
    expect(classifyEmailSender('alice.smith@bigcorp.com')).toBe('person');
  });

  it('classifies first_last patterns as person', () => {
    expect(classifyEmailSender('john_doe@company.com')).toBe('person');
  });

  it('classifies first-last patterns as person', () => {
    expect(classifyEmailSender('john-doe@company.com')).toBe('person');
  });

  // Default (ambiguous single-word) → person (conservative)
  it('defaults ambiguous single-word local parts to person', () => {
    expect(classifyEmailSender('alex@startup.io')).toBe('person');
    expect(classifyEmailSender('dana@company.com')).toBe('person');
  });

  // Malformed email → person (safe default)
  it('returns person for malformed email with no @ sign', () => {
    expect(classifyEmailSender('notanemail')).toBe('person');
  });
});
