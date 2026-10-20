// Tests for the verification config section (#2017): mapping-guard validation in
// loadYamlConfig() and defaults in resolveVerificationConfig().
//
// askChannelOrder decides where Curia asks the principal for a sign-in code, so a
// typo ("pigeon") must fail at boot rather than silently skip every channel.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadYamlConfig, resolveVerificationConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-verification-cfg-'));
  // default.yaml must exist — loadYamlConfig returns {} if absent
  fs.writeFileSync(path.join(tempDir, 'default.yaml'), '');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeLocalYaml(content: string) {
  fs.writeFileSync(path.join(tempDir, 'local.yaml'), content);
}

describe('resolveVerificationConfig', () => {
  it('defaults askChannelOrder to [signal, sms, slack, email]', () => {
    const config = resolveVerificationConfig(undefined);
    expect(config.askChannelOrder).toEqual(['signal', 'sms', 'slack', 'email']);
    expect(config.defaultExpiryMinutes).toBe(10);
    expect(config.recentWindowMinutes).toBe(120);
    expect(config.codeTtlMinutesAfterClose).toBe(120);
    expect(config.emailWaitSeconds).toBe(180);
  });

  it('applies overrides over the defaults', () => {
    const config = resolveVerificationConfig({ askChannelOrder: ['email'], emailWaitSeconds: 60 });
    expect(config.askChannelOrder).toEqual(['email']);
    expect(config.emailWaitSeconds).toBe(60);
    expect(config.defaultExpiryMinutes).toBe(10);
  });

  it('defaults identityProviderDomains to a short list of well-known identity providers', () => {
    expect(resolveVerificationConfig(undefined).identityProviderDomains).toEqual([
      'b2clogin.com', 'microsoftonline.com', 'okta.com', 'auth0.com', 'onelogin.com', 'pingidentity.com', 'duosecurity.com',
    ]);
  });

  it('a configured identityProviderDomains list replaces the default, lowercased', () => {
    const config = resolveVerificationConfig({ identityProviderDomains: ['Okta.com', 'idp.example'] });
    expect(config.identityProviderDomains).toEqual(['okta.com', 'idp.example']);
    expect(resolveVerificationConfig({ identityProviderDomains: [] }).identityProviderDomains).toEqual([]);
  });

  it('returns a fresh askChannelOrder array each call', () => {
    const a = resolveVerificationConfig(undefined);
    a.askChannelOrder.push('mutated');
    expect(resolveVerificationConfig(undefined).askChannelOrder).toEqual(['signal', 'sms', 'slack', 'email']);
  });
});

describe('verification config validation', () => {
  it('accepts a full verification block', () => {
    writeLocalYaml(`
verification:
  askChannelOrder: [slack, email]
  defaultExpiryMinutes: 15
  recentWindowMinutes: 60
  codeTtlMinutesAfterClose: 90
  emailWaitSeconds: 120
`);
    expect(loadYamlConfig(tempDir).verification).toEqual({
      askChannelOrder: ['slack', 'email'],
      defaultExpiryMinutes: 15,
      recentWindowMinutes: 60,
      codeTtlMinutesAfterClose: 90,
      emailWaitSeconds: 120,
    });
  });

  it('accepts identityProviderDomains of bare registrable domains, and an empty list', () => {
    writeLocalYaml(`
verification:
  identityProviderDomains: [okta.com, auth.example]
`);
    expect(loadYamlConfig(tempDir).verification).toEqual({ identityProviderDomains: ['okta.com', 'auth.example'] });
    writeLocalYaml(`
verification:
  identityProviderDomains: []
`);
    expect(loadYamlConfig(tempDir).verification).toEqual({ identityProviderDomains: [] });
  });

  it('rejects a non-list identityProviderDomains', () => {
    writeLocalYaml(`
verification:
  identityProviderDomains: okta.com
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(/verification\.identityProviderDomains must be a list/);
  });

  it.each(['https://okta.com', 'login.okta.com', 'com', '10.0.0.1', '""', '7'])(
    'rejects identityProviderDomains entry %s (not a bare registrable domain)',
    (bad) => {
      writeLocalYaml(`
verification:
  identityProviderDomains: [${bad}]
`);
      expect(() => loadYamlConfig(tempDir)).toThrow(/verification\.identityProviderDomains entry .* must be a registrable domain/);
    },
  );

  it('rejects askChannelOrder: [pigeon]', () => {
    writeLocalYaml(`
verification:
  askChannelOrder: [pigeon]
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(/verification\.askChannelOrder.*pigeon/);
  });

  it('rejects a non-array askChannelOrder', () => {
    writeLocalYaml(`
verification:
  askChannelOrder: signal
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(/verification\.askChannelOrder must be a list/);
  });

  it('rejects an empty askChannelOrder', () => {
    writeLocalYaml(`
verification:
  askChannelOrder: []
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(/verification\.askChannelOrder must not be empty/);
  });

  it('rejects a verification section that is not a mapping', () => {
    writeLocalYaml(`
verification: []
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(/verification must be a YAML mapping/);
  });

  it.each([
    'defaultExpiryMinutes',
    'recentWindowMinutes',
    'codeTtlMinutesAfterClose',
    'emailWaitSeconds',
  ])('rejects a non-positive or non-integer %s', (key) => {
    for (const bad of ['0', '-5', '1.5', '"ten"']) {
      writeLocalYaml(`
verification:
  ${key}: ${bad}
`);
      expect(() => loadYamlConfig(tempDir)).toThrow(new RegExp(`verification\\.${key} must be a positive integer`));
    }
  });
});
