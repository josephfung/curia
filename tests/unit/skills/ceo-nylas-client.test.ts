import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { htmlToPlainText } from '../../../skills/_shared/ceo-nylas-client.js';

// We can't easily mock global fetch per-test with vi.fn(), so instead we
// test the CeoNylasClient by spying on global.fetch and inspecting the URL
// it receives — that's where the folder alias normalization is observable.

const logger = pino({ level: 'silent' });

// Dynamically import after setting up the fetch mock so the module-level
// constant (`NYLAS_BASE`) picks up correctly.
let CeoNylasClient: typeof import('../../../skills/_shared/ceo-nylas-client.js').CeoNylasClient;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import('../../../skills/_shared/ceo-nylas-client.js');
  CeoNylasClient = mod.CeoNylasClient;
});

function mockFetchSuccess(data: unknown = []) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('htmlToPlainText', () => {
  it('returns empty string for null or undefined input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText(undefined)).toBe('');
  });

  it('strips basic HTML tags', () => {
    expect(htmlToPlainText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('converts <br> to newlines', () => {
    expect(htmlToPlainText('Line 1<br>Line 2')).toContain('Line 1\nLine 2');
  });

  it('strips <script> blocks including their content', () => {
    const html = 'before <script>alert(1)</script> after';
    const result = htmlToPlainText(html);
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('<script');
  });

  it('strips <style> blocks including their content', () => {
    const html = '<style>.x { color: red; }</style><p>Content</p>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Content');
    expect(result).not.toContain('color');
    expect(result).not.toContain('<style');
  });

  it('strips <script> blocks whose closing tag has trailing whitespace (</script >)', () => {
    const html = 'before <script>evil()</script > after';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('evil');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('handles nested-substitution bypass attempt (<scri<script>pt>)', () => {
    // A crafted input that tries to smuggle <script> through the strip:
    // stripping the inner <script>...</script> block leaves outer fragments
    // that merge into a new <script> tag. The stability loop catches this.
    const html = '<scri<script>alert(1)</script>pt>payload</script>';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('&amp; &lt; &gt;')).toBe('& < >');
  });
});

describe('CeoNylasClient.listMessages — folder alias normalization', () => {
  it('normalizes DRAFTS to DRAFT for Gmail compatibility', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'DRAFTS' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('DRAFT');
  });

  it('passes INBOX unchanged (no alias needed)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'INBOX' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('INBOX');
  });

  it('passes DRAFT unchanged (already correct)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'DRAFT' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('DRAFT');
  });

  it('passes custom label names through unmodified', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'Label_42' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('Label_42');
  });
});

describe('CeoNylasClient — drafts (issue #1000)', () => {
  const RAW_DRAFT_SUMMARY = {
    id: 'draft-1',
    thread_id: 'thread-1',
    subject: 'Quarterly update',
    to: [{ name: 'Alice', email: 'alice@example.com' }],
    cc: [{ email: 'bob@example.com' }],
    snippet: 'Hi Alice, here is the update',
    date: 1_700_000_000,
  };

  describe('listDrafts', () => {
    it('hits the /drafts collection — NOT /messages', async () => {
      const fetchSpy = mockFetchSuccess([RAW_DRAFT_SUMMARY]);
      const client = new CeoNylasClient('key', 'grant', logger);
      await client.listDrafts({ limit: 25 });

      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.pathname.endsWith('/drafts')).toBe(true);
      expect(url.pathname).not.toContain('/messages');
      expect(url.searchParams.get('limit')).toBe('25');
    });

    it('never sends a received_after / watermark param', async () => {
      const fetchSpy = mockFetchSuccess([RAW_DRAFT_SUMMARY]);
      const client = new CeoNylasClient('key', 'grant', logger);
      await client.listDrafts({ limit: 10 });

      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.searchParams.get('received_after')).toBeNull();
    });

    it('normalizes the raw draft into a summary with recipients', async () => {
      mockFetchSuccess([RAW_DRAFT_SUMMARY]);
      const client = new CeoNylasClient('key', 'grant', logger);
      const drafts = await client.listDrafts({ limit: 10 });

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        id: 'draft-1',
        threadId: 'thread-1',
        subject: 'Quarterly update',
        to: [{ name: 'Alice', email: 'alice@example.com' }],
        cc: [{ email: 'bob@example.com' }],
        snippet: 'Hi Alice, here is the update',
        date: 1_700_000_000,
      });
    });
  });

  describe('getDraft', () => {
    it('GETs /drafts/{id} and returns the full draft with body', async () => {
      const fetchSpy = mockFetchSuccess({
        ...RAW_DRAFT_SUMMARY,
        bcc: [{ email: 'carol@example.com' }],
        body: '<p>Hi Alice</p>',
      });
      const client = new CeoNylasClient('key', 'grant', logger);
      const draft = await client.getDraft('draft-1');

      const call = fetchSpy.mock.calls[0]!;
      const url = new URL(call[0] as string);
      expect(url.pathname.endsWith('/drafts/draft-1')).toBe(true);
      expect((call[1] as RequestInit).method).toBe('GET');
      expect(draft.body).toBe('<p>Hi Alice</p>');
      expect(draft.bcc).toEqual([{ name: undefined, email: 'carol@example.com' }]);
    });
  });

  describe('updateDraft', () => {
    it('PUTs /drafts/{id} with only the provided fields and returns the updated draft', async () => {
      const fetchSpy = mockFetchSuccess({
        ...RAW_DRAFT_SUMMARY,
        to: [{ email: 'corrected@example.com' }],
        subject: 'Corrected subject',
        body: '<p>Updated</p>',
        bcc: [],
      });
      const client = new CeoNylasClient('key', 'grant', logger);
      const updated = await client.updateDraft('draft-1', {
        to: [{ email: 'corrected@example.com' }],
        subject: 'Corrected subject',
        body: '<p>Updated</p>',
      });

      const call = fetchSpy.mock.calls[0]!;
      const url = new URL(call[0] as string);
      const init = call[1] as RequestInit;
      expect(url.pathname.endsWith('/drafts/draft-1')).toBe(true);
      expect(init.method).toBe('PUT');

      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sentBody).toEqual({
        to: [{ email: 'corrected@example.com' }],
        subject: 'Corrected subject',
        body: '<p>Updated</p>',
      });
      // cc was not provided — it must be absent so we don't blank out the draft's existing CC.
      expect(sentBody).not.toHaveProperty('cc');

      expect(updated.to).toEqual([{ name: undefined, email: 'corrected@example.com' }]);
      expect(updated.subject).toBe('Corrected subject');
      expect(updated.body).toBe('<p>Updated</p>');
    });
  });
});
