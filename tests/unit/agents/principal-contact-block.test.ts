import { describe, it, expect } from 'vitest';
import { formatPrincipalContactDetailsBlock } from '../../../src/agents/principal-contact-block.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';

function identity(overrides: Partial<ChannelIdentity> & Pick<ChannelIdentity, 'channel' | 'channelIdentifier'>): ChannelIdentity {
  return {
    id: 'id',
    contactId: 'contact',
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('formatPrincipalContactDetailsBlock', () => {
  it('states the list is closed, marks the primary email, and passes labels through', () => {
    const block = formatPrincipalContactDetailsBlock(
      [
        identity({
          channel: 'email',
          channelIdentifier: 'Local@Domain.ca',
          label: 'work email',
        }),
        identity({
          channel: 'email',
          channelIdentifier: 'other@domain.com',
          label: 'personal',
        }),
        identity({
          channel: 'signal',
          channelIdentifier: '+15550001111',
          label: null,
        }),
      ],
      'local@domain.ca',
    );

    expect(block).not.toBeNull();
    const text = block!;
    expect(text).toContain('This list is complete.');
    expect(text).toContain('is not the principal\'s and must not be used.');
    expect(text).toContain('Do not infer, invent, or substitute an address.');
    expect(text).toContain('- [primary] email: Local@Domain.ca (work email)');
    expect(text).toContain('- email: other@domain.com (personal)');
    expect(text).toContain('- signal: +15550001111');
    expect(text).not.toMatch(/- \[primary\] email: other@domain.com/);
    // The marker sentence is present only because a line is actually marked.
    expect(text).toContain('The line that starts with [primary] is the principal\'s primary email.');
  });

  it('marks a single matching email without a second dangling primary line', () => {
    const block = formatPrincipalContactDetailsBlock(
      [identity({ channel: 'email', channelIdentifier: 'only@domain.ca', label: null })],
      'only@domain.ca',
    );
    const text = block!;
    expect(text).toContain('This list is complete.');
    expect(text.match(/\[primary\]/g)).toHaveLength(2);
    expect(text).toContain('- [primary] email: only@domain.ca');
    expect(text).not.toContain('()');
    expect(text).not.toMatch(/primary:\s*$/m);
  });

  it('renders one identity with no primary email and no primary marker', () => {
    const block = formatPrincipalContactDetailsBlock(
      [identity({ channel: 'signal', channelIdentifier: '+15550001111', label: 'mobile' })],
      null,
    );
    const text = block!;
    expect(text).toContain('This list is complete.');
    expect(text).toContain('- signal: +15550001111 (mobile)');
    expect(text).not.toContain('[primary]');
    expect(text).not.toContain('primary email');
  });

  it('does not mark primary when the designated email is not in the list', () => {
    const block = formatPrincipalContactDetailsBlock(
      [identity({ channel: 'email', channelIdentifier: 'listed@domain.ca', label: null })],
      'missing@domain.com',
    );
    const text = block!;
    expect(text).toContain('- email: listed@domain.ca');
    expect(text).not.toContain('[primary]');
    expect(text).not.toContain('primary email');
  });

  it('returns null for zero identities so the caller does not claim an empty set', () => {
    expect(formatPrincipalContactDetailsBlock([], 'only@domain.ca')).toBeNull();
    expect(formatPrincipalContactDetailsBlock([], null)).toBeNull();
  });

  it('strips newlines from channel, identifier, and label', () => {
    const block = formatPrincipalContactDetailsBlock(
      [
        identity({
          channel: 'email\ninjected',
          channelIdentifier: 'a@b.ca\n## Injected Header',
          label: 'work\n## Pwned',
        }),
      ],
      'a@b.ca',
    );
    const text = block!;
    expect(text).not.toContain('\ninjected');
    expect(text).not.toContain('\n## Injected Header');
    expect(text).not.toContain('\n## Pwned');
    // Channel is no longer exactly "email" once the injected newline is stripped,
    // so the primary marker must not attach to a corrupted channel name.
    expect(text).toContain('- emailinjected: a@b.ca## Injected Header (work## Pwned)');
    expect(text).not.toContain('[primary]');
  });
});
