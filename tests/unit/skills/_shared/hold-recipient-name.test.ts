import { describe, expect, it } from 'vitest';
import { HOLD_RECIPIENT_NAME_MAX, holdRecipientName } from '../../../../src/skills/_shared/hold-recipient-name.js';

// A held send's approval names the contact (scenario 34k), and a display name can be written by an
// outsider, so it is sanitized and capped before it reaches the approval card.
describe('holdRecipientName', () => {
  it('uses the contact name', () => {
    expect(holdRecipientName('Dana Reyes', 'unlabelled', '+14155550100')).toBe('Dana Reyes');
  });

  it('falls back to the identity label, then the destination, when the name is blank', () => {
    expect(holdRecipientName('  ', 'Work phone', '+14155550100')).toBe('Work phone');
    expect(holdRecipientName(undefined, undefined, 'U0DANAREYES')).toBe('U0DANAREYES');
  });

  it('strips markup an outsider put in their name', () => {
    expect(holdRecipientName('<b>Dana</b> <script>x</script>Reyes', undefined, '+14155550100')).not.toMatch(/[<>]/);
  });

  it('caps a name that is really a paragraph', () => {
    const long = 'Dana '.repeat(40);
    expect(holdRecipientName(long, undefined, '+14155550100').length).toBeLessThanOrEqual(HOLD_RECIPIENT_NAME_MAX);
  });
});
