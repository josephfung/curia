// build-principal-sender-context.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildPrincipalSenderContext } from './build-principal-sender-context.js';
import { createSilentLogger } from '../logger.js';

const PRINCIPAL_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE = 'test';

describe('buildPrincipalSenderContext', () => {
  it('builds from a real principal contact and forces systemRole/tier/kind to principal', () => {
    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const ctx = buildPrincipalSenderContext(
      {
        id: PRINCIPAL_ID,
        displayName: 'Joseph',
        role: 'ceo',
        systemRole: 'principal',
        kgNodeId: 'kg-1',
        kind: 'principal',
      },
      logger,
      SOURCE,
    );

    expect(ctx).toEqual({
      resolved: true,
      contactId: PRINCIPAL_ID,
      displayName: 'Joseph',
      role: 'ceo',
      systemRole: 'principal',
      verified: true,
      kgNodeId: 'kg-1',
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 1.0,
      tier: 'principal',
      kind: 'principal',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('forces systemRole to principal and warns when the row is stale', () => {
    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const ctx = buildPrincipalSenderContext(
      {
        id: PRINCIPAL_ID,
        displayName: 'Joseph',
        role: 'ceo',
        systemRole: null,
        kgNodeId: null,
        kind: 'principal',
      },
      logger,
      SOURCE,
    );

    expect(ctx.systemRole).toBe('principal');
    expect(ctx.tier).toBe('principal');
    expect(ctx.kind).toBe('principal');
    expect(warnSpy).toHaveBeenCalledWith(
      { source: SOURCE, contactId: PRINCIPAL_ID, systemRole: null },
      'principal contact has systemRole != "principal"',
    );
  });

  it('warns when stored kind is not principal (migration-055) but still forces kind', () => {
    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const ctx = buildPrincipalSenderContext(
      {
        id: PRINCIPAL_ID,
        displayName: 'Joseph',
        role: 'ceo',
        systemRole: 'principal',
        kgNodeId: null,
        kind: 'person',
      },
      logger,
      SOURCE,
    );

    expect(ctx.kind).toBe('principal');
    expect(ctx.tier).toBe('principal');
    expect(warnSpy).toHaveBeenCalledWith(
      { source: SOURCE, contactId: PRINCIPAL_ID, kind: 'person' },
      'principal contact has kind != "principal" — migration-055 backfill may have missed this row',
    );
  });

  it('falls back to the synthetic primary-user principal when no row exists', () => {
    const ctx = buildPrincipalSenderContext(null, createSilentLogger(), SOURCE);
    expect(ctx).toEqual({
      resolved: true,
      contactId: 'primary-user',
      displayName: 'CEO',
      role: 'ceo',
      systemRole: 'principal',
      verified: true,
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 1.0,
      tier: 'principal',
      kind: 'principal',
    });
  });
});
