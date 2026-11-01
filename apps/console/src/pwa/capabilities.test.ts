import { describe, expect, it } from 'vitest';
import { installCapabilityWarning, pairPageNotice } from './capabilities.js';
import { PHONE_DOCS_URL } from '../../../../src/phone/phone-docs.js';

const ready = {
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  notifications: true,
  ios: false,
  standalone: false,
};

describe('installCapabilityWarning', () => {
  it('is quiet when the browser can install and notify', () => {
    expect(installCapabilityWarning(ready)).toBeNull();
  });

  it('says the site still opens when install is impossible', () => {
    const warning = installCapabilityWarning({ ...ready, secureContext: false });
    expect(warning).toMatch(/can't install/i);
    expect(warning).toContain(PHONE_DOCS_URL);
    expect(warning).not.toMatch(/home screen/i);
    expect(installCapabilityWarning({ ...ready, serviceWorker: false })).toBe(warning);
  });

  it('tells an iPhone that is not installed to add Curia to the Home Screen', () => {
    expect(installCapabilityWarning({ ...ready, ios: true, standalone: false }))
      .toBe('Add Curia to your Home Screen to get notifications.');
  });

  it('says notifications are missing when the installed app cannot push', () => {
    expect(installCapabilityWarning({ ...ready, pushManager: false })).toMatch(/can't receive notifications/i);
    expect(installCapabilityWarning({ ...ready, ios: true, standalone: true, notifications: false }))
      .toMatch(/can't receive notifications/i);
  });
});

describe('pairPageNotice', () => {
  it('shows the origin warning on its own when both would apply', () => {
    expect(pairPageNotice('use https', 'open only')).toBe('use https');
    expect(pairPageNotice(null, 'open only')).toBe('open only');
  });
});
