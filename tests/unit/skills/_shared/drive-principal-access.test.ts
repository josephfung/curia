import { describe, it, expect } from 'vitest';
import {
  principalDriveGrantNote,
  raisePrincipalDriveGrant,
} from '../../../../src/skills/_shared/drive-principal-access.js';
import type { ChannelIdentity } from '../../../../src/contacts/types.js';

function identity(over: Partial<ChannelIdentity>): ChannelIdentity {
  return {
    id: 'id-1',
    contactId: 'principal-1',
    channel: 'email',
    channelIdentifier: 'ceo@example.test',
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const principal = [
  identity({}),
  identity({ id: 'id-2', channelIdentifier: 'CEO.Personal@Example.test', label: 'personal' }),
  identity({ id: 'id-3', channel: 'signal', channelIdentifier: '+15555550100' }),
];

const grant = (over: Record<string, unknown>) => ({
  file_id: 'doc-1',
  action: 'grant',
  share_with: 'ceo@example.test',
  ...over,
});

describe('raisePrincipalDriveGrant', () => {
  it.each(['reader', 'commenter'])('raises a %s grant to the principal to writer', (role) => {
    const out = raisePrincipalDriveGrant('manage_drive_access', grant({ role }), principal);
    expect(out.input).toEqual(grant({ role: 'writer' }));
    expect(out.raisedFrom).toEqual([role]);
  });

  it('raises a grant with no role, which the server would make reader', () => {
    const out = raisePrincipalDriveGrant('manage_drive_access', grant({}), principal);
    expect(out.input.role).toBe('writer');
    expect(out.raisedFrom).toEqual(['reader']);
  });

  it('matches any of the principal’s email addresses, ignoring case and spaces', () => {
    const out = raisePrincipalDriveGrant(
      'manage_drive_access',
      grant({ share_with: ' ceo.personal@example.TEST ', role: 'reader' }),
      principal,
    );
    expect(out.input.role).toBe('writer');
  });

  it('leaves a writer grant to the principal unchanged', () => {
    const input = grant({ role: 'writer' });
    const out = raisePrincipalDriveGrant('manage_drive_access', input, principal);
    expect(out.input).toBe(input);
    expect(out.raisedFrom).toEqual([]);
  });

  it('leaves the role chosen for anyone else', () => {
    const input = grant({ share_with: 'vendor@example.test', role: 'reader' });
    const out = raisePrincipalDriveGrant('manage_drive_access', input, principal);
    expect(out.input).toBe(input);
    expect(out.raisedFrom).toEqual([]);
  });

  it('leaves a group or domain share alone even when it names the principal’s address', () => {
    const input = grant({ share_type: 'group', role: 'reader' });
    expect(raisePrincipalDriveGrant('manage_drive_access', input, principal).input).toBe(input);
  });

  it('ignores unverified and defunct addresses', () => {
    const others = [
      identity({ channelIdentifier: 'old@example.test', verified: false }),
      identity({ id: 'id-9', channelIdentifier: 'gone@example.test', status: 'defunct' }),
    ];
    for (const share_with of ['old@example.test', 'gone@example.test']) {
      const input = grant({ share_with, role: 'reader' });
      expect(raisePrincipalDriveGrant('manage_drive_access', input, others).input).toBe(input);
    }
  });

  it('raises only the principal’s entries in a batch grant', () => {
    const input = {
      file_id: 'doc-1',
      action: 'grant_batch',
      recipients: [
        { email: 'vendor@example.test', role: 'reader' },
        { email: 'CEO@example.test', role: 'commenter' },
        { email: 'ceo.personal@example.test' },
      ],
    };
    const out = raisePrincipalDriveGrant('manage_drive_access', input, principal);
    expect(out.input.recipients).toEqual([
      { email: 'vendor@example.test', role: 'reader' },
      { email: 'CEO@example.test', role: 'writer' },
      { email: 'ceo.personal@example.test', role: 'writer' },
    ]);
    expect(out.raisedFrom).toEqual(['commenter', 'reader']);
    // The model's input is not mutated.
    expect(input.recipients[1]).toEqual({ email: 'CEO@example.test', role: 'commenter' });
  });

  it('passes through other actions, other tools and an empty identity snapshot', () => {
    const update = { file_id: 'doc-1', action: 'update', permission_id: 'p1', role: 'reader' };
    expect(raisePrincipalDriveGrant('manage_drive_access', update, principal).input).toBe(update);
    const other = grant({ role: 'reader' });
    expect(raisePrincipalDriveGrant('update_drive_file', other, principal).input).toBe(other);
    expect(raisePrincipalDriveGrant('manage_drive_access', other, []).input).toBe(other);
  });
});

describe('principalDriveGrantNote', () => {
  it('names the role the model asked for once', () => {
    expect(principalDriveGrantNote(['reader', 'reader'])).toBe(
      'Note: the principal was given writer (edit) access, not reader. ' +
        'The principal always gets edit access to files shared with them.',
    );
  });
});
