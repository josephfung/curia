// Tests for resolveChannelAccounts() — focused on the observation_mode and
// excluded_sender_emails fields added for CEO inbox monitoring (#273).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveChannelAccounts, loadYamlConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Minimal Config stub — only fields referenced by resolveChannelAccounts are needed.
const baseConfig: Config = {
  databaseUrl: 'postgres://localhost/test',
  anthropicApiKey: undefined,
  openaiApiKey: undefined,
  logLevel: 'error',
  httpPort: 3000,
  apiToken: undefined,
  webAppBootstrapSecret: undefined,
  appOrigin: undefined,
  timezone: 'America/Toronto',
  nylasApiKey: undefined,
  nylasGrantId: undefined,
  nylasPollingIntervalMs: 30000,
  nylasSelfEmail: '',
  ceoPrimaryEmail: undefined,
  signalPhoneNumber: undefined,
  signalSocketPath: undefined,
  tavilyApiKey: undefined,
  googleApplicationCredentials: undefined,
};

// Write a temp default.yaml and a local.yaml-style string to a temp dir,
// then call loadYamlConfig to get a YamlConfig for resolveChannelAccounts.
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ch-acct-'));
  // default.yaml must exist but can be empty — resolveChannelAccounts reads yamlConfig
  fs.writeFileSync(path.join(tempDir, 'default.yaml'), '');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeLocalYaml(content: string) {
  fs.writeFileSync(path.join(tempDir, 'local.yaml'), content);
}

describe('resolveChannelAccounts — observation_mode', () => {
  it('defaults observationMode to false when observation_mode is absent', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    curia:
      nylas_grant_id: grant-1
      self_email: curia@example.com
      outbound_policy: direct
`);
    const yamlConfig = loadYamlConfig(tempDir);
    const accounts = resolveChannelAccounts(yamlConfig, baseConfig);
    expect(accounts[0]?.observationMode).toBe(false);
  });

  it('sets observationMode to true when observation_mode: true', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: draft_gate
      observation_mode: true
`);
    const yamlConfig = loadYamlConfig(tempDir);
    const accounts = resolveChannelAccounts(yamlConfig, baseConfig);
    expect(accounts[0]?.observationMode).toBe(true);
  });

  it('throws when observation_mode is not a boolean', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: draft_gate
      observation_mode: "yes"
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('observation_mode must be a boolean');
  });

  it('throws when observation_mode is true but outbound_policy is not draft_gate', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: direct
      observation_mode: true
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      "observation_mode requires outbound_policy 'draft_gate'",
    );
  });
});

describe('resolveChannelAccounts — excluded_sender_emails', () => {
  it('defaults excludedSenderEmails to [] when absent', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    curia:
      nylas_grant_id: grant-1
      self_email: curia@example.com
      outbound_policy: direct
`);
    const yamlConfig = loadYamlConfig(tempDir);
    const accounts = resolveChannelAccounts(yamlConfig, baseConfig);
    expect(accounts[0]?.excludedSenderEmails).toEqual([]);
  });

  it('resolves literal excluded_sender_emails entries', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: draft_gate
      excluded_sender_emails:
        - curia@example.com
        - noreply@example.com
`);
    const yamlConfig = loadYamlConfig(tempDir);
    const accounts = resolveChannelAccounts(yamlConfig, baseConfig);
    expect(accounts[0]?.excludedSenderEmails).toEqual(['curia@example.com', 'noreply@example.com']);
  });

  it('resolves env: references in excluded_sender_emails', () => {
    const prev = process.env['TEST_EXCLUDED_EMAIL'];
    process.env['TEST_EXCLUDED_EMAIL'] = 'curia@example.com';
    try {
      writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: draft_gate
      excluded_sender_emails:
        - "env:TEST_EXCLUDED_EMAIL"
`);
      const yamlConfig = loadYamlConfig(tempDir);
      const accounts = resolveChannelAccounts(yamlConfig, baseConfig);
      expect(accounts[0]?.excludedSenderEmails).toEqual(['curia@example.com']);
    } finally {
      if (prev === undefined) {
        delete process.env['TEST_EXCLUDED_EMAIL'];
      } else {
        process.env['TEST_EXCLUDED_EMAIL'] = prev;
      }
    }
  });

  it('throws when excluded_sender_emails is not a list', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: draft_gate
      excluded_sender_emails: "curia@example.com"
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('excluded_sender_emails must be a list');
  });

  it('throws when an excluded_sender_emails entry is not a string', () => {
    writeLocalYaml(`
channel_accounts:
  email:
    joseph:
      nylas_grant_id: grant-2
      self_email: joseph@example.com
      outbound_policy: draft_gate
      excluded_sender_emails:
        - 123
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('excluded_sender_emails entries must be non-empty strings');
  });
});

describe('resolveChannelAccounts — backward-compat single-account path', () => {
  it('sets observationMode: false and excludedSenderEmails: [] on the legacy synthetic account', () => {
    // No local.yaml — falls back to env-var mode (nylasGrantId + nylasSelfEmail)
    const yamlConfig = loadYamlConfig(tempDir); // default.yaml is empty, no local.yaml
    const config: Config = {
      ...baseConfig,
      nylasGrantId: 'legacy-grant',
      nylasSelfEmail: 'curia@example.com',
    };
    const accounts = resolveChannelAccounts(yamlConfig, config);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.name).toBe('curia');
    expect(accounts[0]?.observationMode).toBe(false);
    expect(accounts[0]?.excludedSenderEmails).toEqual([]);
  });
});
