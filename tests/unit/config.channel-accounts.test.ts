// Tests for resolveChannelAccounts() — focused on the observation_mode and
// excluded_sender_emails fields added for CEO inbox monitoring (#273).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveChannelAccounts, resolveGoogleWorkspaceAccounts, loadYamlConfig } from '../../src/config.js';
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

// ---------------------------------------------------------------------------
// Google Workspace account resolution (#387)
// ---------------------------------------------------------------------------

describe('resolveGoogleWorkspaceAccounts', () => {
  it('returns empty array when google_workspace section is absent', () => {
    const yamlConfig = loadYamlConfig(tempDir); // default.yaml is empty
    const accounts = resolveGoogleWorkspaceAccounts(yamlConfig);
    expect(accounts).toEqual([]);
  });

  it('resolves literal google_email values', () => {
    writeLocalYaml(`
channel_accounts:
  google_workspace:
    curia:
      google_email: curia@gmail.com
      primary: true
    joseph:
      google_email: joseph@example.com
`);
    const yamlConfig = loadYamlConfig(tempDir);
    const accounts = resolveGoogleWorkspaceAccounts(yamlConfig);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toEqual({ name: 'curia', googleEmail: 'curia@gmail.com', primary: true });
    expect(accounts[1]).toEqual({ name: 'joseph', googleEmail: 'joseph@example.com', primary: false });
  });

  it('resolves env: references in google_email', () => {
    const prev = process.env['TEST_GOOGLE_EMAIL'];
    process.env['TEST_GOOGLE_EMAIL'] = 'resolved@gmail.com';
    try {
      writeLocalYaml(`
channel_accounts:
  google_workspace:
    curia:
      google_email: "env:TEST_GOOGLE_EMAIL"
      primary: true
`);
      const yamlConfig = loadYamlConfig(tempDir);
      const accounts = resolveGoogleWorkspaceAccounts(yamlConfig);
      expect(accounts[0]?.googleEmail).toBe('resolved@gmail.com');
    } finally {
      if (prev === undefined) {
        delete process.env['TEST_GOOGLE_EMAIL'];
      } else {
        process.env['TEST_GOOGLE_EMAIL'] = prev;
      }
    }
  });

  it('defaults primary to false when omitted', () => {
    writeLocalYaml(`
channel_accounts:
  google_workspace:
    curia:
      google_email: curia@gmail.com
`);
    const yamlConfig = loadYamlConfig(tempDir);
    const accounts = resolveGoogleWorkspaceAccounts(yamlConfig);
    expect(accounts[0]?.primary).toBe(false);
  });

  it('throws when google_email is missing', () => {
    writeLocalYaml(`
channel_accounts:
  google_workspace:
    curia:
      primary: true
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('google_email must be a non-empty string');
  });

  it('throws when primary is not a boolean', () => {
    writeLocalYaml(`
channel_accounts:
  google_workspace:
    curia:
      google_email: curia@gmail.com
      primary: "yes"
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('primary must be a boolean');
  });

  it('throws when multiple accounts are marked primary', () => {
    writeLocalYaml(`
channel_accounts:
  google_workspace:
    curia:
      google_email: curia@gmail.com
      primary: true
    joseph:
      google_email: joseph@example.com
      primary: true
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('at most one account may be marked primary');
  });

  it('throws when google_workspace is not a mapping', () => {
    writeLocalYaml(`
channel_accounts:
  google_workspace: "invalid"
`);
    expect(() => loadYamlConfig(tempDir)).toThrow('google_workspace must be a YAML mapping');
  });
});
