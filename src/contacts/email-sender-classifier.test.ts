// src/contacts/email-sender-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyEmailSender } from './contact-service.js';

describe('classifyEmailSender', () => {
  // ---- Automated senders (checked first — before webmail domain and name patterns) ----

  it('classifies noreply variants as automated', () => {
    expect(classifyEmailSender('noreply@github.com')).toBe('automated');
    expect(classifyEmailSender('no-reply@stripe.com')).toBe('automated');
    expect(classifyEmailSender('no_reply@acme.com')).toBe('automated');
    expect(classifyEmailSender('donotreply@shopify.com')).toBe('automated');
    expect(classifyEmailSender('do-not-reply@acme.com')).toBe('automated');
    expect(classifyEmailSender('do_not_reply@acme.com')).toBe('automated');
  });

  it('classifies mailer-daemon as automated', () => {
    expect(classifyEmailSender('mailer-daemon@mailserver.example')).toBe('automated');
    expect(classifyEmailSender('mailerdaemon@example.com')).toBe('automated');
  });

  it('classifies notification/alert/newsletter local-parts as automated', () => {
    expect(classifyEmailSender('notifications@slack.com')).toBe('automated');
    expect(classifyEmailSender('notification@github.com')).toBe('automated');
    expect(classifyEmailSender('alerts@monitoring.io')).toBe('automated');
    expect(classifyEmailSender('alert@pagerduty.com')).toBe('automated');
    expect(classifyEmailSender('newsletter@substack.com')).toBe('automated');
    expect(classifyEmailSender('newsletters@acme.com')).toBe('automated');
    expect(classifyEmailSender('updates@stripe.com')).toBe('automated');
    expect(classifyEmailSender('update@github.com')).toBe('automated');
  });

  it('classifies bounce/unsubscribe/postmaster as automated', () => {
    expect(classifyEmailSender('bounce@amazonses.com')).toBe('automated');
    expect(classifyEmailSender('bounces@sendgrid.net')).toBe('automated');
    expect(classifyEmailSender('bounced@mailchimp.com')).toBe('automated');
    expect(classifyEmailSender('unsubscribe@acme.com')).toBe('automated');
    expect(classifyEmailSender('postmaster@example.com')).toBe('automated');
  });

  it('classifies automated/auto as automated', () => {
    expect(classifyEmailSender('automated@system.example')).toBe('automated');
    expect(classifyEmailSender('auto@system.example')).toBe('automated');
  });

  // AUTOMATED CHECK RUNS BEFORE WEBMAIL DOMAIN CHECK — this is the critical ordering test.
  // noreply@gmail.com should be 'automated', not 'person'.
  it('classifies noreply on personal webmail domain as automated (not person)', () => {
    expect(classifyEmailSender('noreply@gmail.com')).toBe('automated');
    expect(classifyEmailSender('mailer-daemon@googlemail.com')).toBe('automated');
    expect(classifyEmailSender('bounce@yahoo.com')).toBe('automated');
  });

  // ---- Organization addresses (stay as organization, not promoted to automated) ----

  it('classifies org role addresses as organization', () => {
    expect(classifyEmailSender('info@startup.io')).toBe('organization');
    expect(classifyEmailSender('support@cloudflare.com')).toBe('organization');
    expect(classifyEmailSender('admin@company.com')).toBe('organization');
    expect(classifyEmailSender('billing@shopify.com')).toBe('organization');
    expect(classifyEmailSender('team@acme.com')).toBe('organization');
    expect(classifyEmailSender('help@acme.com')).toBe('organization');
    expect(classifyEmailSender('hello@startup.io')).toBe('organization');
    expect(classifyEmailSender('sales@company.com')).toBe('organization');
    expect(classifyEmailSender('news@bbc.com')).toBe('organization');
  });

  // ---- Personal webmail domains → always person (for non-automated local-parts) ----

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

  // ---- Personal name patterns → person ----

  it('classifies first.last patterns as person', () => {
    expect(classifyEmailSender('john.doe@company.com')).toBe('person');
    expect(classifyEmailSender('alice.smith@bigcorp.com')).toBe('person');
  });

  it('classifies first_last and first-last patterns as person', () => {
    expect(classifyEmailSender('john_doe@company.com')).toBe('person');
    expect(classifyEmailSender('john-doe@company.com')).toBe('person');
  });

  // ---- Default (ambiguous single-word) → person (conservative) ----

  it('defaults ambiguous single-word local parts to person', () => {
    expect(classifyEmailSender('alex@startup.io')).toBe('person');
    expect(classifyEmailSender('dana@company.com')).toBe('person');
  });

  // ---- Malformed ----

  it('returns person for malformed email with no @ sign', () => {
    expect(classifyEmailSender('notanemail')).toBe('person');
  });
});
