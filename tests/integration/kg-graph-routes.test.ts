// GET /api/kg/graph against real Postgres (#2479): the focal view keeps the focal node
// and its nearest neighbours, scope=all returns the whole live graph, and every response
// carries whole-graph totals.
//
// Other integration files write kg_nodes in parallel, so assertions are on this file's
// own node ids and on a node type no other file uses — never on absolute totals.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import pino from 'pino';
import { knowledgeGraphRoutes } from '../../src/channels/http/routes/kg.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { EventBus } from '../../src/bus/bus.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const SOURCE = 'it-kg-graph-2479';
// A node type only this file creates, so its totals are exact under parallel writers.
const OWN_TYPE = 'it2479_entity';
const SECRET = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': SECRET };

interface GraphBody {
  nodes: Array<{ id: string; type: string }>;
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
  truncated: boolean;
  totals: { nodes: number; edges: number; byType: Record<string, number>; bySensitivity: Record<string, number> };
}

describeIf('GET /api/kg/graph (#2479)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;

  async function node(label: string, opts: { type?: string; ageDays: number; archived?: boolean; sensitivity?: string }): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, source, sensitivity, last_confirmed_at, archived_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(days => $5), CASE WHEN $6 THEN now() END)
       RETURNING id`,
      [opts.type ?? OWN_TYPE, `${SOURCE} ${label}`, SOURCE, opts.sensitivity ?? 'internal', opts.ageDays, opts.archived ?? false],
    );
    return res.rows[0]!.id;
  }

  async function edge(a: string, b: string, opts: { archived?: boolean } = {}): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, source, archived_at)
       VALUES ($1, $2, 'relates_to', $3, CASE WHEN $4 THEN now() END)
       RETURNING id`,
      [a, b, SOURCE, opts.archived ?? false],
    );
    return res.rows[0]!.id;
  }

  async function get(url: string): Promise<{ status: number; body: GraphBody }> {
    const res = await app.inject({ method: 'GET', url, headers: auth });
    return { status: res.statusCode, body: res.json() as GraphBody };
  }

  async function cleanup(): Promise<void> {
    // Edges go with their nodes (ON DELETE CASCADE).
    await pool.query('DELETE FROM kg_nodes WHERE source = $1', [SOURCE]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await cleanup();
    app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: pino({ level: 'silent' }),
      webAppBootstrapSecret: SECRET,
      secureCookies: false,
      contactService: {} as unknown as ContactService,
      sessions: new Map(),
      bus: { async publish() { /* login audit is not under test */ } } as unknown as EventBus,
    });
    await app.ready();
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
    await pool?.end();
  });

  it('keeps a focal node older than 100+ neighbours, and fills the limit with direct neighbours first', async () => {
    // The anchor is the least recently confirmed node in its neighbourhood. Its 120
    // direct neighbours are recent, and the 40 two-hop nodes are the most recent of all,
    // so ranking on recency alone would drop the anchor and favour the far nodes.
    const anchor = await node('anchor', { ageDays: 400 });
    const near: string[] = [];
    for (let i = 0; i < 120; i++) {
      const n = await node(`near ${i}`, { ageDays: 10 });
      near.push(n);
      await edge(anchor, n);
    }
    const far: string[] = [];
    for (let i = 0; i < 40; i++) {
      const f = await node(`far ${i}`, { ageDays: 0 });
      far.push(f);
      await edge(near[i]!, f);
    }

    const { status, body } = await get(`/api/kg/graph?node_id=${anchor}&depth=2`);
    expect(status).toBe(200);
    const ids = new Set(body.nodes.map(n => n.id));
    expect(body.nodes).toHaveLength(100);
    expect(body.nodes[0]!.id).toBe(anchor);
    expect(body.truncated).toBe(true);
    // Anchor + 99 direct neighbours; no two-hop node gets in ahead of a direct one.
    expect(far.some(f => ids.has(f))).toBe(false);
    expect(near.filter(n => ids.has(n))).toHaveLength(99);

    // With room to spare, every direct neighbour is in and the rest goes to two-hop nodes.
    const roomy = await get(`/api/kg/graph?node_id=${anchor}&depth=2&limit=300`);
    const roomyIds = new Set(roomy.body.nodes.map(n => n.id));
    expect(roomy.body.truncated).toBe(false);
    expect(roomy.body.nodes).toHaveLength(161);
    expect(near.every(n => roomyIds.has(n)) && far.every(f => roomyIds.has(f))).toBe(true);
    // Every edge between returned nodes comes back — none are capped away.
    expect(roomy.body.edges).toHaveLength(160);

    await cleanup();
  });

  it('scope=all returns every live non-fact node and live edge between them, facts on request', async () => {
    const a = await node('all a', { ageDays: 900 });
    const b = await node('all b', { ageDays: 800 });
    const fact = await node('all fact', { type: 'fact', ageDays: 1 });
    const decayed = await node('all decayed', { ageDays: 1, archived: true });
    const ab = await edge(a, b);
    const archivedEdge = await edge(b, a, { archived: true });
    const toFact = await edge(a, fact);
    const toDecayed = await edge(a, decayed);

    const { status, body } = await get('/api/kg/graph?scope=all');
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    const ids = new Set(body.nodes.map(n => n.id));
    const edgeIds = new Set(body.edges.map(e => e.id));
    expect(ids.has(a) && ids.has(b)).toBe(true);
    expect(ids.has(fact)).toBe(false);
    expect(ids.has(decayed)).toBe(false);
    expect(body.nodes.some(n => n.type === 'fact')).toBe(false);
    expect(edgeIds.has(ab)).toBe(true);
    expect(edgeIds.has(archivedEdge) || edgeIds.has(toFact) || edgeIds.has(toDecayed)).toBe(false);

    const withFacts = await get('/api/kg/graph?scope=all&include_facts=true');
    expect(withFacts.body.nodes.some(n => n.id === fact)).toBe(true);
    expect(withFacts.body.edges.some(e => e.id === toFact)).toBe(true);
    expect(withFacts.body.nodes.some(n => n.id === decayed)).toBe(false);

    // Merge tombstones are archived, so they never appear in the full graph.
    await pool.query(
      `UPDATE kg_nodes SET archived_at = now(), properties = properties || jsonb_build_object('merged_into', $2::text)
       WHERE id = $1`,
      [b, a],
    );
    const afterMerge = await get('/api/kg/graph?scope=all');
    expect(afterMerge.body.nodes.some(n => n.id === b)).toBe(false);

    await cleanup();
  });

  it('reports whole-graph totals that count live nodes only, by type and sensitivity', async () => {
    await node('t1', { ageDays: 1, sensitivity: 'confidential' });
    await node('t2', { ageDays: 1 });
    await node('t3', { ageDays: 1, archived: true });

    const { body } = await get('/api/kg/graph?limit=5');
    expect(body.totals.byType[OWN_TYPE]).toBe(2);
    expect(body.totals.nodes).toBeGreaterThanOrEqual(2);
    expect(body.totals.bySensitivity['confidential']).toBeGreaterThanOrEqual(1);
    const sumByType = Object.values(body.totals.byType).reduce((s, n) => s + n, 0);
    const sumBySens = Object.values(body.totals.bySensitivity).reduce((s, n) => s + n, 0);
    expect(sumByType).toBe(body.totals.nodes);
    expect(sumBySens).toBe(body.totals.nodes);

    await cleanup();
  });

  it('flags a truncated top-N view, and exclude_facts keeps facts out of it', async () => {
    await node('top a', { ageDays: 0 });
    await node('top b', { ageDays: 0 });
    await node('top fact', { type: 'fact', ageDays: -1 });

    const one = await get('/api/kg/graph?limit=1');
    expect(one.body.nodes).toHaveLength(1);
    expect(one.body.truncated).toBe(true);

    const noFacts = await get('/api/kg/graph?limit=50&exclude_facts=true');
    expect(noFacts.body.nodes.some(n => n.type === 'fact')).toBe(false);

    await cleanup();
  });

  it('rejects an unknown scope and scope=all with node_id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/kg/graph?scope=everything', headers: auth })).statusCode).toBe(400);
    const anchor = '11111111-2222-4333-8444-555555555555';
    expect((await app.inject({ method: 'GET', url: `/api/kg/graph?scope=all&node_id=${anchor}`, headers: auth })).statusCode).toBe(400);
  });
});
