import { describe, expect, it } from 'vitest';
import { installCapabilityWarning } from './capabilities.js';

const ready = {
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  notifications: true,
};

describe('installCapabilityWarning', () => {
  it('is quiet when the browser can install and notify', () => {
    expect(installCapabilityWarning(ready)).toBeNull();
  });

  it('says the site still opens when install is impossible', () => {
    expect(installCapabilityWarning({ ...ready, secureContext: false })).toMatch(/can't install/i);
    expect(installCapabilityWarning({ ...ready, serviceWorker: false })).toMatch(/short code/i);
  });

  it('says notifications are missing when push is unavailable', () => {
    expect(installCapabilityWarning({ ...ready, pushManager: false })).toMatch(/can't receive notifications/i);
  });
});
