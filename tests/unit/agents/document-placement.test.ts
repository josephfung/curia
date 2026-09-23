import { describe, it, expect } from 'vitest';
import {
  allocateUniqueProjectSlug,
  collisionShortId,
  isLegacyUuidProjectDir,
  isWellFormedProjectSlug,
  listProjectDirectorySummaries,
  projectDirectoryPrefix,
  recommendPlacement,
  resolveOwnedWorkspacePrefix,
  softSlugWordMatch,
  suggestProjectSlug,
  validateProjectsWritePath,
} from '../../../src/agents/document-placement.js';
import type { WorkingDocRow } from '../../../src/db/working-docs-repo.js';

function doc(path: string, overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: 'id',
    path,
    type: 'note',
    frontmatter: {},
    body: '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-06-28T12:00:00.000Z',
    updatedAt: '2026-06-28T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('suggestProjectSlug / validation', () => {
  it('kebab-cases titles and rejects UUID-shaped new slugs', () => {
    expect(suggestProjectSlug('Social Media Queue')).toBe('social-media-queue');
    expect(isWellFormedProjectSlug('social-media')).toBe(true);
    expect(isWellFormedProjectSlug('Social Media')).toBe(false);
    expect(isLegacyUuidProjectDir('3467d2d0-1695-4d90-9789-3319ba5a2c65')).toBe(true);
    expect(isWellFormedProjectSlug('3467d2d0-1695-4d90-9789-3319ba5a2c65')).toBe(false);
  });

  it('validates /projects write paths — UUID only when legacy or bound root', () => {
    expect(validateProjectsWritePath('/projects/social-media/brief.md')).toBeNull();
    expect(validateProjectsWritePath('/scratch/c/note.md')).toBeNull();
    expect(validateProjectsWritePath('/projects/Not Valid/brief.md')).toMatch(/kebab-case/i);

    const uuid = '3467d2d0-1695-4d90-9789-3319ba5a2c65';
    expect(validateProjectsWritePath(`/projects/${uuid}/brief.md`)).toMatch(/Cannot create/);
    expect(validateProjectsWritePath(`/projects/${uuid}/brief.md`, {
      legacyFolderOccupied: true,
    })).toBeNull();
    expect(validateProjectsWritePath(`/projects/${uuid}/brief.md`, {
      boundRootTaskId: uuid,
    })).toBeNull();
  });
});

describe('softSlugWordMatch', () => {
  it('matches on whole hyphenated words, not characters', () => {
    expect(softSlugWordMatch('social-media', 'social-media-queue')).toBe(true);
    expect(softSlugWordMatch('ai', 'email-campaign')).toBe(false);
    expect(softSlugWordMatch('q3', 'q3-board-deck')).toBe(false);
    expect(softSlugWordMatch('plan', 'planning-offsite')).toBe(false);
    expect(softSlugWordMatch('project', 'my-project-notes')).toBe(false);
    expect(softSlugWordMatch('board-deck', 'q3-board-deck')).toBe(true);
  });
});

describe('allocateUniqueProjectSlug', () => {
  const root = '00000000-0000-4000-8000-00000000abcd';

  it('returns the proposed slug when free', async () => {
    expect(await allocateUniqueProjectSlug('social-media', root, () => false)).toBe('social-media');
  });

  it('appends a short task id when occupied', async () => {
    const short = collisionShortId(root);
    expect(await allocateUniqueProjectSlug('social-media', root, (s) => s === 'social-media'))
      .toBe(`social-media-${short}`);
  });

  it('increments when the short-id form is also taken', async () => {
    const short = collisionShortId(root);
    const occupied = new Set([`social-media`, `social-media-${short}`]);
    expect(await allocateUniqueProjectSlug('social-media', root, (s) => occupied.has(s)))
      .toBe(`social-media-${short}-2`);
  });
});

describe('recommendPlacement', () => {
  const catalog = [
    {
      slug: 'social-media',
      directoryPrefix: '/projects/social-media/',
      documentCount: 2,
      samplePaths: ['/projects/social-media/queue.md'],
      sampleTitles: ['Queue'],
    },
    {
      slug: 'email-campaign',
      directoryPrefix: '/projects/email-campaign/',
      documentCount: 1,
      samplePaths: ['/projects/email-campaign/brief.md'],
      sampleTitles: ['Brief'],
    },
  ];

  it('prefers extend when a matching document exists', async () => {
    const result = await recommendPlacement({
      title: 'Social media',
      leaf: 'queue.md',
      catalog,
      documentsInFolder: [doc('/projects/social-media/queue.md', { frontmatter: { title: 'Queue' } })],
      rootTaskId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.action).toBe('extend');
    expect(result.path).toBe('/projects/social-media/queue.md');
  });

  it('adds to an existing folder when no leaf match', async () => {
    const result = await recommendPlacement({
      proposedSlug: 'social-media',
      leaf: 'plan.md',
      catalog,
      documentsInFolder: [doc('/projects/social-media/queue.md')],
    });
    expect(result.action).toBe('add_to_folder');
    expect(result.directoryPrefix).toBe('/projects/social-media/');
  });

  it('does not soft-match character substrings into extend/add', async () => {
    const result = await recommendPlacement({
      title: 'AI',
      catalog,
      documentsInFolder: [doc('/projects/email-campaign/brief.md')],
    });
    expect(result.action).toBe('create_folder');
    expect(result.slug).toBe('ai');
  });

  it('creates a new folder when nothing matches', async () => {
    const result = await recommendPlacement({
      title: 'Evan neurology prep',
      catalog: [],
    });
    expect(result.action).toBe('create_folder');
    expect(result.slug).toBe('evan-neurology-prep');
    expect(result.directoryPrefix).toBe('/projects/evan-neurology-prep/');
  });

  it('allocates a unique slug when prefer_new_folder and name taken', async () => {
    const root = '00000000-0000-4000-8000-00000000abcd';
    const result = await recommendPlacement({
      proposedSlug: 'social-media',
      preferNewFolder: true,
      catalog,
      rootTaskId: root,
    });
    expect(result.action).toBe('create_folder');
    expect(result.slug).toBe(`social-media-${collisionShortId(root)}`);
    expect(result.allocated).toBe(true);
  });

  it('checks -new collisions when no rootTaskId', async () => {
    const occupiedCatalog = [
      ...catalog,
      {
        slug: 'social-media-new',
        directoryPrefix: '/projects/social-media-new/',
        documentCount: 1,
        samplePaths: ['/projects/social-media-new/x.md'],
        sampleTitles: [],
      },
    ];
    const result = await recommendPlacement({
      proposedSlug: 'social-media',
      preferNewFolder: true,
      catalog: occupiedCatalog,
    });
    expect(result.slug).toBe('social-media-new-2');
  });

  it('uses prefixOccupied when the folder sits outside the catalog window', async () => {
    const result = await recommendPlacement({
      proposedSlug: 'vendor-review',
      leaf: 'plan.md',
      catalog: [],
      prefixOccupied: (slug) => slug === 'vendor-review',
      leafExists: async () => false,
    });
    expect(result.action).toBe('add_to_folder');
    expect(result.directoryPrefix).toBe('/projects/vendor-review/');
  });

  it('extends via leafExists without documentsInFolder', async () => {
    const result = await recommendPlacement({
      proposedSlug: 'vendor-review',
      leaf: 'brief.md',
      catalog: [],
      prefixOccupied: (slug) => slug === 'vendor-review',
      leafExists: (path) => path === '/projects/vendor-review/brief.md',
    });
    expect(result.action).toBe('extend');
    expect(result.path).toBe('/projects/vendor-review/brief.md');
  });

  it('allocates via prefixOccupied when prefer_new_folder and catalog misses the hit', async () => {
    const root = '00000000-0000-4000-8000-00000000abcd';
    const result = await recommendPlacement({
      proposedSlug: 'vendor-review',
      preferNewFolder: true,
      catalog: [],
      rootTaskId: root,
      prefixOccupied: (slug) => slug === 'vendor-review',
    });
    expect(result.action).toBe('create_folder');
    expect(result.slug).toBe(`vendor-review-${collisionShortId(root)}`);
    expect(result.allocated).toBe(true);
  });
});

describe('resolveOwnedWorkspacePrefix / catalog', () => {
  it('resolves pointer, then owned docs, then legacy UUID prefix', () => {
    expect(resolveOwnedWorkspacePrefix({
      rootTaskId: 'root',
      pointer: { kind: 'document', path: '/projects/audit/accumulator.md' },
      ownedDocuments: [],
    })).toBe('/projects/audit/');

    expect(resolveOwnedWorkspacePrefix({
      rootTaskId: 'root',
      ownedDocuments: [
        doc('/projects/social-media/brief.md', {
          taskId: 'root',
          updatedAt: '2026-06-29T12:00:00.000Z',
        }),
      ],
    })).toBe('/projects/social-media/');

    const uuid = '00000000-0000-4000-8000-000000000099';
    expect(resolveOwnedWorkspacePrefix({
      rootTaskId: uuid,
      ownedDocuments: [],
      legacyUuidDocuments: [doc(`${projectDirectoryPrefix(uuid)}brief.md`)],
    })).toBe(projectDirectoryPrefix(uuid));

    expect(resolveOwnedWorkspacePrefix({
      rootTaskId: uuid,
      ownedDocuments: [],
      legacyUuidDocuments: [],
    })).toBeNull();
  });

  it('summarizes top-level project directories', () => {
    const summaries = listProjectDirectorySummaries([
      doc('/projects/a/brief.md', { frontmatter: { title: 'A' } }),
      doc('/projects/a/plan.md'),
      doc('/projects/b/note.md'),
    ]);
    expect(summaries.map(s => s.slug)).toEqual(['a', 'b']);
    expect(summaries[0]?.documentCount).toBe(2);
  });
});
