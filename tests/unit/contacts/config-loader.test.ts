import { describe, it, expect } from 'vitest';
import { loadAuthConfig } from '../../../src/contacts/config-loader.js';
import * as path from 'node:path';

const CONFIG_DIR = path.resolve(import.meta.dirname, '../../../config');

describe('loadAuthConfig', () => {
  it('loads role defaults from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.roles).toBeDefined();
    expect(config.roles.ceo).toBeDefined();
    expect(config.roles.ceo.defaultPermissions).toContain('*');
    expect(config.roles.unknown.defaultDeny).toContain('*');
  });

  it('loads permissions registry from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.permissions).toBeDefined();
    expect(config.permissions.view_financial_reports.sensitivity).toBe('high');
    expect(config.permissions.schedule_meetings.sensitivity).toBe('low');
  });

  it('loads channel trust levels from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.channelTrust).toBeDefined();
    expect(config.channelTrust.cli).toBe('high');
    expect(config.channelTrust.email).toBe('low');
  });

  it('includes the unknown role as fallback', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.roles.unknown).toBeDefined();
    expect(config.roles.unknown.defaultPermissions).toEqual([]);
  });
});
