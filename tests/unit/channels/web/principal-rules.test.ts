import { describe, expect, it } from 'vitest';
import { webPrincipalRules } from '../../../../src/channels/web/principal-rules.js';

describe('web principal rules', () => {
  it('projects the principal alias and rejects extra recipient fields', () => {
    expect(webPrincipalRules.extractRecipients({
      channel: 'web',
      recipient: 'principal',
      message: 'hello',
    })).toEqual([{ identifier: 'principal', principalEligible: true }]);
    const parse = webPrincipalRules.carveoutSkill?.parseRecipients;
    expect(parse).toBeTypeOf('function');
    expect(parse?.({ recipient: 'principal' })).toEqual(['principal']);
    expect(parse?.({ recipient: 'principal', to: 'a@example.com' })).toBeNull();
    expect(parse?.({ recipient: 'principal', cc: 'a@example.com' })).toBeNull();
    expect(parse?.({ recipient: 'principal', group_id: 'g' })).toBeNull();
    expect(parse?.({ recipient: 'someone-else' })).toBeNull();
  });
});
