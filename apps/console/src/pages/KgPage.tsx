import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import {
  emptyFilter, filterOptions, isFilterActive, matchesFilter, normalizeSensitivity, toggleFilterValue,
} from './kg-filters.js';
import type { KgFacetTotals, KgFilter, KgFilterAxis, KgFilterable } from './kg-filters.js';
import { TYPE_BADGE, SENS_BADGE } from './kg-types.js';
import type { ApiKgNode } from './kg-types.js';
import { MergeNodesDialog } from './MergeNodesDialog.js';
import type { NodeMergeResult } from './kg-merge-types.js';
import {
  applyMergeToNodeList, mergeAvailability, mergedIntoFrom, mergedIntoNotice, mergeResultNotes, mergeSuccessMessage,
} from './kg-merge-utils.js';

// Register fcose layout plugin once at module scope.
cytoscape.use(fcose);

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiKgEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  confidence: number;
}

/** Whole-graph live counts served with every GET /api/kg/graph response (#2479). */
interface ApiKgGraphTotals extends KgFacetTotals {
  nodes: number;
  edges: number;
}

/** GET /api/kg/graph body. `truncated`: a limit cut nodes from this view. */
interface ApiKgGraph {
  nodes: ApiKgNode[];
  edges: ApiKgEdge[];
  truncated?: boolean;
  totals?: ApiKgGraphTotals;
}

type ColorMode = 'type' | 'sensitivity' | 'decay';

/** The page banner after a merge or a merged-node redirect. */
interface KgBanner {
  text: string;
  /** Follow-up notes (post-commit merge warnings); the banner turns amber when present. */
  notes?: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SENS_COLORS: Record<string, string> = {
  public:       '#5E9E6B',
  internal:     '#4174C8',
  confidential: '#C9874A',
  restricted:   '#E86040',
};

const DECAY_COLORS: Record<string, string> = {
  permanent:  '#5E9E6B',
  slow_decay: '#4174C8',
  fast_decay: '#E86040',
};

// Edge types that represent close structural relationships — their pairs should
// sit visually adjacent in the layout.
const STRONG_EDGES = new Set([
  'spouse', 'parent', 'child', 'sibling',
  'reports_to', 'manages', 'member_of', 'founded', 'invested_in', 'advises',
]);

// Weighting factors for edge elasticity based on how quickly connected nodes
// go stale. Permanent facts create tight springs; fast-decaying info goes soft.
const DECAY_SCORE: Record<string, number> = {
  permanent:  1.0,
  slow_decay: 0.7,
  fast_decay: 0.4,
};

// ── fCoSE physics callbacks ───────────────────────────────────────────────────

// Fact nodes are children of entities; low repulsion keeps them clustered
// nearby. High-traffic entity types need more space to avoid crowding.
function nodeRepulsionFn(node: cytoscape.NodeSingular): number {
  const type = node.data('type') as string;
  if (type === 'fact') return 3_000;
  if (type === 'person' || type === 'organization' || type === 'event') return 20_000;
  return 12_000; // project, decision, concept
}

// Fact edges stay short so attributes cluster against their parent entity.
// Strong relationship pairs sit visually adjacent; generic edges settle at 150px.
// Lengths are sized against the 90px label width so neighbours' labels don't collide.
function idealEdgeLengthFn(edge: cytoscape.EdgeSingular): number {
  const srcType = edge.source().data('type') as string;
  const tgtType = edge.target().data('type') as string;
  if (srcType === 'fact' || tgtType === 'fact') return 70;
  if (STRONG_EDGES.has(edge.data('label') as string)) return 110;
  return 150;
}

// Strong relationships attract hard (0.9). For others: weight by confidence
// and the weaker decay score of the two endpoints — stale or uncertain edges
// produce soft springs so those nodes drift outward naturally.
function edgeElasticityFn(edge: cytoscape.EdgeSingular): number {
  if (STRONG_EDGES.has(edge.data('label') as string)) return 0.9;
  const conf = (edge.data('confidence') as number | undefined | null) ?? 0.5;
  const srcScore = DECAY_SCORE[edge.source().data('decayClass') as string] ?? 0.7;
  const tgtScore = DECAY_SCORE[edge.target().data('decayClass') as string] ?? 0.7;
  return Math.max(0.1, conf * Math.min(srcScore, tgtScore) * 0.7);
}

// Shared spacing options. nodeDimensionsIncludeLabels makes fCoSE treat each
// node's label as part of its footprint, which is what stops labels overlapping;
// the lower gravity lets components spread instead of being pulled into a ball.
// 'proof' quality is the documented requirement for both
// nodeDimensionsIncludeLabels and the expansion layout's randomize: false;
// its slower cooling also settles the spread-out layout more fully.
const FCOSE_SPACING = {
  quality: 'proof',
  nodeDimensionsIncludeLabels: true,
  nodeSeparation: 120,
  gravity: 0.1,
};

// fcose layout options per the issue spec.
const FCOSE_FULL = {
  name: 'fcose',
  animate: false,
  fit: true,
  ...FCOSE_SPACING,
  randomize: true,
  idealEdgeLength: idealEdgeLengthFn,
  nodeRepulsion: nodeRepulsionFn,
  edgeElasticity: edgeElasticityFn,
};

const FCOSE_EXPAND = {
  name: 'fcose',
  animate: true,
  fit: false,
  ...FCOSE_SPACING,
  randomize: false,
  animationDuration: 400,
  idealEdgeLength: idealEdgeLengthFn,
  nodeRepulsion: nodeRepulsionFn,
  edgeElasticity: edgeElasticityFn,
};

// Cytoscape's TS types don't model mapData() string expressions (the library
// supports them at runtime but types them as numbers). Cast to satisfy the compiler.
const CY_STYLE = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'background-color': '#4174C8',
      color: '#FAFAFA',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 5,
      'text-outline-color': '#111827',
      'text-outline-width': 2,
      'text-wrap': 'ellipsis',
      'text-max-width': '90px',
      'font-size': 10,
      'font-family': 'Manrope, system-ui, sans-serif',
      // Degree-based size: updated by updateDegrees() after every cy.add().
      // Wider range than before so hub nodes stand out more dramatically.
      width: 'mapData(degree, 0, 15, 20, 80)',
      height: 'mapData(degree, 0, 15, 20, 80)',
      // Confidence-based opacity.
      opacity: 'mapData(confidence, 0, 1, 0.15, 1.0)',
    },
  },
  // Type colour overrides.
  { selector: 'node[type="person"]',       style: { 'background-color': '#478189' } },
  { selector: 'node[type="organization"]', style: { 'background-color': '#6BAED6' } },
  { selector: 'node[type="project"]',      style: { 'background-color': '#7E6BA8' } },
  { selector: 'node[type="decision"]',     style: { 'background-color': '#C9874A' } },
  { selector: 'node[type="event"]',        style: { 'background-color': '#5E9E6B' } },
  { selector: 'node[type="concept"]',      style: { 'background-color': '#888888' } },
  // Facts are decorations, not hubs — fixed small size regardless of degree.
  { selector: 'node[type="fact"]',         style: { 'background-color': '#444444', width: 10, height: 10 } },
  // Facts: hide label at default size; reveal on select.
  { selector: 'node[type="fact"]',         style: { 'font-size': 0 } },
  { selector: 'node[type="fact"]:selected', style: { 'font-size': 9 } },
  // Focal node: white border on the most recently tapped node.
  { selector: 'node.focal', style: { 'border-width': 3, 'border-color': '#FAFAFA', 'border-opacity': 0.9 } },
  // Filter panel (#351): display:none also hides every edge touching the node.
  { selector: 'node.filtered-out', style: { display: 'none' } },
  {
    selector: 'edge',
    style: {
      width: 'mapData(confidence, 0, 1, 1, 3.5)',
      opacity: 'mapData(confidence, 0, 1, 0.15, 0.7)',
      'line-color': 'rgba(255,255,255,0.6)',
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': 'rgba(255,255,255,0.6)',
      label: 'data(label)',
      'font-size': 8,
      'font-family': 'Manrope, system-ui, sans-serif',
      color: '#ADADAD',
      'text-outline-color': '#111827',
      'text-outline-width': 1,
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function nodeToElement(n: ApiKgNode): cytoscape.ElementDefinition {
  return {
    data: {
      id: n.id,
      label: n.label,
      type: n.type,
      confidence: n.confidence ?? 0.5,
      decayClass: n.decayClass || 'permanent',
      sensitivity: normalizeSensitivity(n.sensitivity),
      properties: n.properties ?? {},
      source: n.source ?? '',
      createdAt: n.createdAt ?? '',
      lastConfirmedAt: n.lastConfirmedAt ?? '',
      // Carried so a tapped node (whose data() becomes selectedNode) still has
      // them for the drawer and the merge dialog.
      aliases: n.aliases ?? [],
      archived: n.archived === true,
      ...(n.identitySource ? { identitySource: n.identitySource } : {}),
      degree: 0, // updated by updateDegrees()
    },
  };
}

function edgeToElement(e: ApiKgEdge): cytoscape.ElementDefinition {
  return {
    data: {
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: e.type,
      confidence: e.confidence ?? 0.5,
    },
  };
}

// Recalculate edge-count per node and store as data so the stylesheet
// mapData(degree, ...) rule can size nodes correctly. Must run after every cy.add().
function updateDegrees(cy: cytoscape.Core) {
  cy.nodes().forEach(node => { node.data('degree', node.degree()); });
}

// Apply a colour-mode override to all nodes. In 'type' mode, removes any
// element-level style overrides so the stylesheet selectors take effect again.
function applyColorMode(cy: cytoscape.Core, mode: ColorMode) {
  if (mode === 'sensitivity') {
    cy.nodes().forEach(node => {
      const color = SENS_COLORS[node.data('sensitivity') as string] ?? '#888888';
      node.style('background-color', color);
    });
  } else if (mode === 'decay') {
    cy.nodes().forEach(node => {
      const color = DECAY_COLORS[node.data('decayClass') as string] ?? '#888888';
      node.style('background-color', color);
    });
  } else {
    cy.nodes().removeStyle('background-color');
  }
}

// Hide nodes that don't match the filter (their edges follow) and show the
// rest. Runs after every cy.add() so expanded nodes respect active filters.
function applyFilter(cy: cytoscape.Core, filter: KgFilter) {
  cy.batch(() => {
    cy.nodes().forEach(node => {
      const visible = matchesFilter(
        { type: node.data('type') as string, sensitivity: node.data('sensitivity') as string },
        filter,
      );
      node.toggleClass('filtered-out', !visible);
    });
  });
}

// Re-apply the active filter and report the canvas's type/sensitivity mix for
// the checklist options. Call after every add/remove of elements.
function syncFilter(cy: cytoscape.Core, filter: KgFilter, setFacets: (f: KgFilterable[]) => void) {
  applyFilter(cy, filter);
  setFacets(cy.nodes().map(n => ({
    type: n.data('type') as string,
    sensitivity: n.data('sensitivity') as string,
  })));
}

// "X of Y" when the server reported totals, so a capped canvas is never read as
// the size of the graph (#2479).
function graphStatus(cy: cytoscape.Core, totals: ApiKgGraphTotals | null): string {
  const hidden = cy.nodes('.filtered-out').length;
  const fmt = (n: number) => n.toLocaleString();
  const base = totals
    ? `${fmt(cy.nodes().length)} of ${fmt(totals.nodes)} nodes · ${fmt(cy.edges().length)} of ${fmt(totals.edges)} edges`
    : `${fmt(cy.nodes().length)} nodes · ${fmt(cy.edges().length)} edges`;
  return hidden > 0 ? `${base} · ${fmt(hidden)} hidden by filters` : base;
}

async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// A /api/kg/graph 404 body: the message to show, and the survivor when the node
// was merged away (`code: 'node_merged'`, design §10.4).
async function notFoundInfo(res: Response): Promise<{ message: string; merged: ReturnType<typeof mergedIntoFrom> }> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: unknown };
      return {
        message: typeof d.error === 'string' && d.error ? d.error : `HTTP ${res.status}`,
        merged: mergedIntoFrom(d),
      };
    } catch (err) {
      console.error('[notFoundInfo] failed to parse JSON error body:', err);
    }
  }
  return { message: `HTTP ${res.status}`, merged: null };
}

// Canvas sizes. Measured on 2026-11-04 (#2479) with this page's fCoSE settings in
// headless Chromium: 300 nodes lay out in ~0.2s and pan/zoom at 60fps; 1,000 drop to
// ~23fps and 3,600 (the whole non-fact graph) to ~7fps with a ~7s layout. 300 is
// also the API's cap. Drawing the whole graph is #2459's job.
//
// HERO_LIMIT: the default view when no node is focused — the most recently confirmed
// entities, facts left out (they are half the graph and hang off one entity).
// FOCAL_LIMIT: a node's two-hop neighbourhood, nearest nodes first.
const HERO_LIMIT = 300;
const FOCAL_LIMIT = 300;

// How many merged-into redirects a single load follows before giving up — a
// guard against a (corrupt) merged_into cycle.
const MAX_MERGE_REDIRECTS = 3;

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// ── Node detail drawer ────────────────────────────────────────────────────────

interface NodeDetailDrawerProps {
  node: ApiKgNode;
  onClose: () => void;
  onMerge: () => void;
}

function NodeDetailDrawer({ node, onClose, onMerge }: NodeDetailDrawerProps) {
  const typeBadgeClass = TYPE_BADGE[node.type] ?? 'badge badge-kg-fact';
  const sensBadgeClass = SENS_BADGE[node.sensitivity] ?? 'badge badge-kg-internal';
  const propEntries = Object.entries(node.properties ?? {});
  const merge = mergeAvailability(node);

  return (
    <div className="kg-detail-drawer">
      <div className="kg-detail-header">
        <div className="kg-detail-header-top">
          <div className="kg-detail-badges">
            <span className={typeBadgeClass}>{node.type}</span>
            <span className={sensBadgeClass}>{node.sensitivity}</span>
          </div>
          <button
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="kg-detail-title">{node.label || '(no label)'}</h2>
      </div>

      <div className="kg-detail-body">
        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Confidence</div>
          <div className="kg-detail-field-value mono">
            {node.confidence != null ? node.confidence.toFixed(3) : '—'}
          </div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Decay class</div>
          <div className="kg-detail-field-value">{node.decayClass || '—'}</div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Source</div>
          <div className="kg-detail-field-value mono">{node.source || '—'}</div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Created</div>
          <div className="kg-detail-field-value">{fmtDate(node.createdAt)}</div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Last confirmed</div>
          <div className="kg-detail-field-value">{fmtDate(node.lastConfirmedAt)}</div>
        </div>

        {propEntries.length > 0 && (
          <div className="kg-detail-field">
            <div className="kg-detail-field-label">Properties</div>
            <table className="kg-props-table">
              <tbody>
                {propEntries.map(([key, val]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>
                      {val !== null && val !== undefined
                        ? (typeof val === 'object' ? JSON.stringify(val) : String(val))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {merge.visible && (
        <div className="drawer-footer">
          <button
            className="btn btn-secondary btn-sm"
            onClick={onMerge}
            disabled={merge.disabled}
            title={merge.reason ?? 'Merge this node with a duplicate'}
          >
            Merge…
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function KgPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  // Read initial search params — used to restore state on refresh/back-nav.
  const { q: initialQ, node: initialNode } = useSearch({ strict: false }) as {
    q?: string;
    node?: string;
  };

  // Graph canvas
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // UI state
  const [sidebarNodes, setSidebarNodes] = useState<ApiKgNode[]>([]);
  const [search, setSearch] = useState(initialQ ?? '');
  const [selectedNode, setSelectedNode] = useState<ApiKgNode | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [filter, setFilter] = useState<KgFilter>(emptyFilter);
  // type/sensitivity of every node on the canvas — feeds the filter checklists.
  const [canvasFacets, setCanvasFacets] = useState<KgFilterable[]>([]);
  // Whole-graph counts from the latest graph response; null until one arrives.
  const [graphTotals, setGraphTotals] = useState<ApiKgGraphTotals | null>(null);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Node merge (#2233): the node the dialog was opened from, and the page banner
  // shown after a merge or a merged-node redirect.
  const [mergeFrom, setMergeFrom] = useState<ApiKgNode | null>(null);
  const [banner, setBanner] = useState<KgBanner | null>(null);

  // Track color mode in a ref so the cytoscape event handlers can read the
  // latest value without capturing a stale closure.
  const colorModeRef = useRef<ColorMode>('type');
  // Same reason for the filter: renderGraph/expandNeighborhood run from the
  // mount-time tap handler and must apply the current filter to new nodes.
  const filterRef = useRef<KgFilter>(emptyFilter());
  // Same reason for the totals: graphStatus runs from the mount-time tap handler.
  const totalsRef = useRef<ApiKgGraphTotals | null>(null);

  // Mirror search state in a ref so the single-mount Cytoscape tap handler
  // can always read the current value without a stale closure.
  const searchRef = useRef(initialQ ?? '');

  // Aborts the previous neighborhood fetch when a new one starts, preventing
  // stale responses from overwriting the canvas after rapid clicks.
  const neighborhoodAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  // Sync URL search params on search/node changes.
  function syncUrl(q: string, nodeId: string | undefined) {
    navigate({
      to: '/kg',
      search: { q: q || undefined, node: nodeId },
      replace: true,
    }).catch(err => {
      console.error('[KgPage] URL sync failed:', err);
    });
  }

  function recordTotals(data: ApiKgGraph) {
    if (!data.totals) return;
    totalsRef.current = data.totals;
    setGraphTotals(data.totals);
  }

  // ── Sidebar node search ────────────────────────────────────────────────────

  const loadSidebarNodes = useCallback(async (q: string) => {
    setLoadError(null);
    try {
      const url = q
        ? `/api/kg/nodes?query=${encodeURIComponent(q)}&limit=100`
        : '/api/kg/nodes?limit=100';
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[] };
      setSidebarNodes(data.nodes);
    } catch (err) {
      console.error('[KgPage] sidebar load failed:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load nodes');
    }
  }, []);

  // ── Hero graph (default view when canvas is empty) ─────────────────────────

  const loadHeroGraph = useCallback(async () => {
    const cy = cyRef.current;
    if (!cy || cy.elements().length > 0) return;
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Loading…');
    try {
      const res = await apiFetch(`/api/kg/graph?limit=${HERO_LIMIT}&exclude_facts=true`, { signal: controller.signal });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as ApiKgGraph;
      if (cy.destroyed()) return;
      recordTotals(data);
      renderGraph(cy, data);
      setStatus(graphStatus(cy, totalsRef.current));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] hero graph load failed:', err);
      setStatus(`Failed to load graph: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, []);

  // ── Full graph replacement ─────────────────────────────────────────────────

  function renderGraph(cy: cytoscape.Core, payload: { nodes: ApiKgNode[]; edges: ApiKgEdge[] }) {
    const elements = [
      ...payload.nodes.map(nodeToElement),
      ...payload.edges.map(edgeToElement),
    ];
    cy.elements().remove();
    cy.add(elements);
    updateDegrees(cy);
    cy.resize();
    cy.layout(FCOSE_FULL as unknown as cytoscape.LayoutOptions).run();
    applyColorMode(cy, colorModeRef.current);
    syncFilter(cy, filterRef.current, setCanvasFacets);
  }

  // ── Load a node's neighborhood and replace canvas ─────────────────────────

  type NeighborhoodLoadResult =
    | { ok: true }
    | { ok: false; aborted: true }
    | { ok: false; aborted?: false; notFoundMessage?: string };

  /**
   * Returns ok:false when the node was not found (or the load failed before render).
   * A node that was merged away is followed to its survivor (§10.4).
   */
  async function loadNeighborhood(nodeId: string, redirects = 0): Promise<NeighborhoodLoadResult> {
    const cy = cyRef.current;
    if (!cy) {
      console.error('[KgPage] loadNeighborhood called before Cytoscape was initialized');
      setStatus('Graph not ready — please refresh');
      return { ok: false };
    }
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Loading…');
    try {
      const res = await apiFetch(
        `/api/kg/graph?node_id=${encodeURIComponent(nodeId)}&depth=2&limit=${FOCAL_LIMIT}`,
        { signal: controller.signal },
      );
      if (res.status === 404) {
        // Drop the dead deep-link so refresh does not re-hit the same 404 (#1881).
        const { message: notFoundMessage, merged } = await notFoundInfo(res);
        // Body read can lose a race with a newer click that aborted this controller.
        if (controller.signal.aborted) return { ok: false, aborted: true };
        if (merged && merged.mergedInto !== nodeId && redirects < MAX_MERGE_REDIRECTS) {
          // Name the node the user opened, not an intermediate hop of a chain
          // (expandNeighborhood sets its own notice before redirecting).
          if (redirects === 0) {
            const label = merged.label ?? (cy.getElementById(nodeId).data('label') as string | undefined) ?? null;
            setBanner({ text: mergedIntoNotice(label) });
          }
          return loadNeighborhood(merged.mergedInto, redirects + 1);
        }
        setSelectedNode(null);
        syncUrl(searchRef.current, undefined);
        setStatus(notFoundMessage);
        return { ok: false, notFoundMessage };
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as ApiKgGraph;
      if (cy.destroyed()) return { ok: false };
      recordTotals(data);
      renderGraph(cy, data);
      // Animate the viewport to center on the focal node after the layout settles.
      const focalEl = cy.getElementById(nodeId);
      if (focalEl.length) {
        cy.animate(
          { fit: { eles: focalEl.closedNeighborhood(), padding: 80 } },
          { duration: 300 },
        );
      }
      // Sync selection + URL so refresh and back-nav restore this view.
      const focused = data.nodes.find(n => n.id === nodeId) ?? null;
      setSelectedNode(focused);
      syncUrl(searchRef.current, focused?.id);
      cy.elements().removeClass('focal');
      if (focused) cy.getElementById(focused.id).addClass('focal');
      setStatus(graphStatus(cy, totalsRef.current));
      return { ok: true };
    } catch (err) {
      // Another load took over neighborhoodAbortRef — do not hero-fallback (#1881 review).
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { ok: false, aborted: true };
      }
      console.error('[KgPage] neighborhood load failed:', err);
      setStatus(`Failed to load: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return { ok: false };
    }
  }

  // ── In-place expansion (single-tap on canvas node) ─────────────────────────

  async function expandNeighborhood(nodeId: string) {
    const cy = cyRef.current;
    if (!cy) return;
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Expanding…');
    try {
      const res = await apiFetch(
        `/api/kg/graph?node_id=${encodeURIComponent(nodeId)}&depth=1`,
        { signal: controller.signal },
      );
      if (res.status === 404) {
        // onetap already selected this node and wrote ?node= — clear the stale
        // element, selection, and URL so the user cannot re-tap the same dead id (#1881).
        const { message: notFoundMessage, merged } = await notFoundInfo(res);
        if (controller.signal.aborted) return;
        const staleLabel = cy.destroyed() ? null : (cy.getElementById(nodeId).data('label') as string | undefined) ?? null;
        if (!cy.destroyed()) {
          cy.getElementById(nodeId).remove();
          updateDegrees(cy);
          syncFilter(cy, filterRef.current, setCanvasFacets);
        }
        if (merged && merged.mergedInto !== nodeId) {
          // Merged since the canvas loaded: follow it to the survivor.
          setBanner({ text: mergedIntoNotice(merged.label ?? staleLabel) });
          void loadNeighborhood(merged.mergedInto, 1);
          return;
        }
        setSelectedNode(null);
        syncUrl(searchRef.current, undefined);
        setStatus(notFoundMessage);
        return;
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as ApiKgGraph;
      recordTotals(data);

      const newNodes = data.nodes.filter(n => !cy.getElementById(n.id).length);
      const newEdges = data.edges.filter(e => !cy.getElementById(e.id).length);
      const newElements = [...newNodes.map(nodeToElement), ...newEdges.map(edgeToElement)];

      if (cy.destroyed()) return;

      if (newElements.length > 0) {
        cy.add(newElements);
        updateDegrees(cy);
        applyColorMode(cy, colorModeRef.current);
        syncFilter(cy, filterRef.current, setCanvasFacets);
        // randomize: false warms fCoSE from current positions without hard-pinning
        // existing nodes, so the graph re-settles globally instead of squeezing
        // new nodes into whatever gaps remain.
        cy.layout(FCOSE_EXPAND as unknown as cytoscape.LayoutOptions).run();
      }

      cy.elements().removeClass('focal');
      cy.getElementById(nodeId).addClass('focal');

      setStatus(graphStatus(cy, totalsRef.current));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] expand failed:', err);
      setStatus(`Failed to expand: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ── Cytoscape initialization ───────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: CY_STYLE as unknown as cytoscape.StylesheetStyle[],
      layout: { name: 'fcose', animate: false } as cytoscape.LayoutOptions,
    });

    cyRef.current = cy;

    cy.on('onetap', 'node', evt => {
      // A merge/redirect notice describes the node it was shown for — drop it when the
      // user opens another one. A redirect from this tap sets its own notice afterwards.
      setBanner(null);
      const nodeData = evt.target.data() as ApiKgNode;
      void expandNeighborhood(evt.target.id());
      setSelectedNode(nodeData);
      // Use searchRef.current — this handler is registered once at mount and
      // would otherwise capture a permanently stale `search` state value.
      syncUrl(searchRef.current, nodeData.id);
    });

    cy.on('dbltap', 'node', evt => {
      cy.animate(
        { fit: { eles: evt.target.closedNeighborhood(), padding: 60 } },
        { duration: 300 },
      );
    });

    // After Cytoscape is initialized, ensure the container has been painted
    // before measuring dimensions — avoids blank canvas on first mount.
    requestAnimationFrame(() => {
      cy.resize();
      cy.fit();
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── On mount: load sidebar + hero graph, restore ?node= if present ─────────

  useEffect(() => {
    void loadSidebarNodes(initialQ ?? '');

    if (initialNode) {
      // Restore ?node= from URL via loadNeighborhood, which handles render,
      // focal class, viewport centering, and URL sync in one shot. On 404 the
      // dead id is cleared from the URL; fall back to the hero graph so the
      // user sees a graph with the not-found status rather than a blank canvas (#1881).
      // Skip fallback when this load was aborted by a newer click (do not steal the canvas).
      void (async () => {
        const result = await loadNeighborhood(initialNode);
        if (!result.ok && !result.aborted && result.notFoundMessage) {
          await loadHeroGraph();
          // loadHeroGraph overwrites status — restore the actionable not-found message.
          setStatus(result.notFoundMessage);
        }
      })();
    } else {
      // Default view: focus on the principal's KG node so the graph opens on
      // a meaningful starting point. Falls back to the hero graph if the
      // principal has no linked KG node or the contacts fetch fails.
      void (async () => {
        try {
          const res = await apiFetch('/api/contacts');
          if (res.ok) {
            const { contacts } = await res.json() as { contacts: Array<{
              systemRole: string | null;
              kgNodeId: string | null;
            }> };
            const principal = contacts.find(c => c.systemRole === 'principal');
            if (principal?.kgNodeId) {
              const result = await loadNeighborhood(principal.kgNodeId);
              // Success, or aborted because the user already started another load — leave it.
              if (result.ok || result.aborted) return;
            }
          } else {
            console.error('[KgPage] principal node lookup: contacts fetch failed with status', res.status);
          }
        } catch (err) {
          console.error('[KgPage] principal node lookup failed:', err);
        }
        void loadHeroGraph();
      })();
    }
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Color mode toggle ──────────────────────────────────────────────────────

  function handleColorMode(mode: ColorMode) {
    setColorMode(mode);
    colorModeRef.current = mode;
    const cy = cyRef.current;
    if (cy) applyColorMode(cy, mode);
  }

  // ── Filter panel ───────────────────────────────────────────────────────────

  function updateFilter(next: KgFilter) {
    setFilter(next);
    filterRef.current = next;
    const cy = cyRef.current;
    if (cy) {
      applyFilter(cy, next);
      setStatus(graphStatus(cy, totalsRef.current));
    }
  }

  const options = filterOptions(canvasFacets, filter, graphTotals);
  const filterActive = isFilterActive(filter);
  // Search results respect the filter too, so the list never offers a node
  // the canvas would hide.
  const visibleSidebarNodes = sidebarNodes.filter(n =>
    matchesFilter({ type: n.type, sensitivity: normalizeSensitivity(n.sensitivity) }, filter));

  function renderFilterAxis(axis: KgFilterAxis, legend: string, opts: typeof options.types) {
    return (
      <fieldset className="kg-filter-axis">
        <legend>{legend}</legend>
        {opts.map(opt => (
          <label key={opt.value} className="kg-filter-option">
            <input
              type="checkbox"
              checked={filter[axis].has(opt.value)}
              onChange={() => updateFilter(toggleFilterValue(filterRef.current, axis, opt.value))}
            />
            <span className="kg-filter-option-name">{opt.value}</span>
            <span
              className="kg-filter-option-count"
              title={opt.total !== undefined ? `${opt.count} on the canvas of ${opt.total} in the graph` : undefined}
            >
              {opt.total !== undefined ? `${opt.count.toLocaleString()} / ${opt.total.toLocaleString()}` : opt.count}
            </span>
          </label>
        ))}
      </fieldset>
    );
  }

  // ── Sidebar search ─────────────────────────────────────────────────────────

  function handleSearch(q: string) {
    setSearch(q);
    searchRef.current = q;
  }

  function submitSearch() {
    syncUrl(search, selectedNode?.id);
    void loadSidebarNodes(search);
  }

  // ── Node merge (#2233) ─────────────────────────────────────────────────────

  async function handleMerged(result: NodeMergeResult, labels: { absorbed: string; survivor: string }) {
    setMergeFrom(null);
    setSidebarNodes(prev => applyMergeToNodeList(prev, result));
    const notes = mergeResultNotes(result.warnings);
    setBanner({ text: mergeSuccessMessage(labels.absorbed, labels.survivor), ...(notes.length > 0 ? { notes } : {}) });
    // Take the archived node off the canvas now (its edges go with it), so it
    // is gone even if the reload below fails.
    const cy = cyRef.current;
    if (cy && !cy.destroyed()) {
      cy.getElementById(result.absorbedId).remove();
      cy.getElementById(result.survivorId).data('label', result.node.label);
      updateDegrees(cy);
      syncFilter(cy, filterRef.current, setCanvasFacets);
      setStatus(graphStatus(cy, totalsRef.current));
    }
    // Re-render around the survivor; this also selects it and syncs ?node=.
    const loaded = await loadNeighborhood(result.survivorId);
    if (!loaded.ok && !loaded.aborted) {
      // The merge committed even if the reload failed — still show the survivor.
      setSelectedNode(result.node);
      syncUrl(searchRef.current, result.survivorId);
    }
  }

  // The apply request may or may not have committed (network or gateway
  // error). Refresh the list and the canvas so the user can see which: if it
  // did, the reload follows the absorbed node's redirect to the survivor.
  function handleMergeOutcomeUnknown() {
    void loadSidebarNodes(searchRef.current);
    const focusId = selectedNode?.id ?? mergeFrom?.id;
    if (focusId) void loadNeighborhood(focusId);
  }

  // ── Drawer close ───────────────────────────────────────────────────────────

  function handleDrawerClose() {
    setSelectedNode(null);
    syncUrl(search, undefined);
    // Defer so the browser paints the wider layout before Cytoscape re-measures.
    requestAnimationFrame(() => {
      cyRef.current?.resize();
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="kg" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Knowledge Graph">
            <TopbarSearch
              placeholder="Search nodes…"
              value={search}
              onChange={v => handleSearch(v)}
              onSubmit={submitSearch}
            />
            <TopbarDivider />
          </Topbar>

          {/* Mobile search bar (TopbarSearch hidden at ≤768px) */}
          <div className="kg-mobile-search">
            <input
              type="text"
              placeholder="Search nodes…"
              value={search}
              onChange={e => handleSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitSearch(); }}
            />
          </div>

          <div className="kg-layout">
              {/* Left: node list sidebar */}
              <div className="kg-sidebar">
                <div className="kg-sidebar-search">
                  <input
                    type="text"
                    placeholder="Search…"
                    value={search}
                    onChange={e => handleSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitSearch(); }}
                    aria-label="Search knowledge graph nodes"
                  />
                  <button onClick={submitSearch}>Search</button>
                </div>
                <details className="kg-filters" open>
                  <summary>
                    Filters{filterActive ? ` (${filter.types.size + filter.sensitivities.size})` : ''}
                    {filterActive && (
                      <button
                        className="kg-filters-clear"
                        onClick={e => { e.preventDefault(); updateFilter(emptyFilter()); }}
                      >
                        Clear filters
                      </button>
                    )}
                  </summary>
                  {renderFilterAxis('types', 'Type', options.types)}
                  {renderFilterAxis('sensitivities', 'Sensitivity', options.sensitivities)}
                </details>
                <div className="kg-sidebar-list">
                  {loadError ? (
                    <p style={{ fontSize: 12, color: 'var(--app-destructive)', margin: 0 }}>
                      {loadError}
                    </p>
                  ) : visibleSidebarNodes.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: 0 }}>
                      {sidebarNodes.length > 0 ? 'No nodes match the active filters.' : 'No matching nodes.'}
                    </p>
                  ) : (
                    visibleSidebarNodes.map(node => (
                      <button
                        key={node.id}
                        className="kg-node-card"
                        onClick={() => { setBanner(null); void loadNeighborhood(node.id); }}
                        title={`Load ${node.label}'s neighborhood`}
                      >
                        <div className="kg-node-card-label">{node.label}</div>
                        <div className="kg-node-card-meta">
                          {node.type} · {node.confidence != null ? node.confidence.toFixed(2) : '—'}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              {/* Center: canvas + toolbar */}
              <div className="kg-canvas-wrap">
                <div className="kg-toolbar">
                  <span className="kg-toolbar-label">Color by</span>
                  <button
                    className={`kg-color-btn${colorMode === 'type' ? ' active' : ''}`}
                    onClick={() => handleColorMode('type')}
                    aria-pressed={colorMode === 'type'}
                  >
                    Type
                  </button>
                  <button
                    className={`kg-color-btn${colorMode === 'sensitivity' ? ' active' : ''}`}
                    onClick={() => handleColorMode('sensitivity')}
                    aria-pressed={colorMode === 'sensitivity'}
                  >
                    Sensitivity
                  </button>
                  <button
                    className={`kg-color-btn${colorMode === 'decay' ? ' active' : ''}`}
                    onClick={() => handleColorMode('decay')}
                    aria-pressed={colorMode === 'decay'}
                  >
                    Decay
                  </button>
                  {status && <span className="kg-status">{status}</span>}
                </div>
                {banner && (
                  <div className={`kg-merge-banner${banner.notes?.length ? ' is-warn' : ''}`} role="status">
                    <div className="kg-merge-banner-body">
                      <span>{banner.text}</span>
                      {banner.notes && banner.notes.length > 0 && (
                        <ul className="kg-merge-banner-notes">
                          {banner.notes.map(n => <li key={n}>{n}</li>)}
                        </ul>
                      )}
                    </div>
                    <button
                      className="kg-merge-banner-close"
                      onClick={() => setBanner(null)}
                      aria-label="Dismiss"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}
                <div className="kg-canvas" ref={containerRef} />
              </div>

              {/* Right: node detail drawer (conditional) */}
              {selectedNode && (
                <NodeDetailDrawer
                  key={selectedNode.id}
                  node={selectedNode}
                  onClose={handleDrawerClose}
                  onMerge={() => setMergeFrom(selectedNode)}
                />
              )}
              {mergeFrom && (
                <MergeNodesDialog
                  key={mergeFrom.id}
                  node={mergeFrom}
                  onClose={() => setMergeFrom(null)}
                  onMerged={(result, labels) => void handleMerged(result, labels)}
                  onOutcomeUnknown={handleMergeOutcomeUnknown}
                />
              )}
            </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
