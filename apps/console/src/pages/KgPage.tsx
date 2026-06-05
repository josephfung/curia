import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// Register fcose layout plugin once at module scope.
cytoscape.use(fcose);

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiKgNode {
  id: string;
  label: string;
  type: string;
  confidence: number;
  decayClass: string;
  sensitivity: string;
  properties: Record<string, unknown>;
  source: string;
  createdAt: string;
  lastConfirmedAt: string;
}

interface ApiKgEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  confidence: number;
}

type ColorMode = 'type' | 'sensitivity' | 'decay';

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

// Badge CSS classes for node type in the detail drawer.
const TYPE_BADGE: Record<string, string> = {
  person:       'badge badge-kg-person',
  organization: 'badge badge-kg-organization',
  project:      'badge badge-kg-project',
  decision:     'badge badge-kg-decision',
  event:        'badge badge-kg-event',
  concept:      'badge badge-kg-concept',
  fact:         'badge badge-kg-fact',
};

// Badge CSS classes for sensitivity level in the detail drawer.
const SENS_BADGE: Record<string, string> = {
  public:       'badge badge-kg-public',
  internal:     'badge badge-kg-internal',
  confidential: 'badge badge-kg-confidential',
  restricted:   'badge badge-kg-restricted',
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
  if (type === 'fact') return 1_000;
  if (type === 'person' || type === 'organization' || type === 'event') return 7_500;
  return 4_500; // project, decision, concept — fCoSE default
}

// Fact edges stay short so attributes cluster against their parent entity.
// Strong relationship pairs sit visually adjacent; generic edges settle at 80px.
function idealEdgeLengthFn(edge: cytoscape.EdgeSingular): number {
  const srcType = edge.source().data('type') as string;
  const tgtType = edge.target().data('type') as string;
  if (srcType === 'fact' || tgtType === 'fact') return 40;
  if (STRONG_EDGES.has(edge.data('label') as string)) return 60;
  return 80;
}

// Strong relationships attract hard (0.9). For others: weight by confidence
// and the weaker decay score of the two endpoints — stale or uncertain edges
// produce soft springs so those nodes drift outward naturally.
function edgeElasticityFn(edge: cytoscape.EdgeSingular): number {
  if (STRONG_EDGES.has(edge.data('label') as string)) return 0.9;
  const conf = (edge.data('confidence') as number) ?? 0.5;
  const srcScore = DECAY_SCORE[edge.source().data('decayClass') as string] ?? 0.7;
  const tgtScore = DECAY_SCORE[edge.target().data('decayClass') as string] ?? 0.7;
  return Math.max(0.1, conf * Math.min(srcScore, tgtScore) * 0.7);
}

// fcose layout options per the issue spec.
const FCOSE_FULL = {
  name: 'fcose',
  animate: false,
  fit: true,
  nodeSeparation: 80,
  randomize: true,
  idealEdgeLength: idealEdgeLengthFn,
  nodeRepulsion: nodeRepulsionFn,
  edgeElasticity: edgeElasticityFn,
};

const FCOSE_EXPAND = {
  name: 'fcose',
  animate: true,
  fit: false,
  nodeSeparation: 80,
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
      sensitivity: n.sensitivity || 'internal',
      properties: n.properties ?? {},
      source: n.source ?? '',
      createdAt: n.createdAt ?? '',
      lastConfirmedAt: n.lastConfirmedAt ?? '',
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
}

function NodeDetailDrawer({ node, onClose }: NodeDetailDrawerProps) {
  const typeBadgeClass = TYPE_BADGE[node.type] ?? 'badge badge-kg-fact';
  const sensBadgeClass = SENS_BADGE[node.sensitivity] ?? 'badge badge-kg-internal';
  const propEntries = Object.entries(node.properties ?? {});

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
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Track color mode in a ref so the cytoscape event handlers can read the
  // latest value without capturing a stale closure.
  const colorModeRef = useRef<ColorMode>('type');

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
      const res = await apiFetch('/api/kg/graph?limit=20', { signal: controller.signal });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[]; edges: ApiKgEdge[] };
      if (cy.destroyed()) return;
      renderGraph(cy, data);
      setStatus(`${data.nodes.length} nodes · ${data.edges.length} edges`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] hero graph load failed:', err);
      setStatus('Failed to load graph');
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
  }

  // ── Load a node's neighborhood and replace canvas ─────────────────────────

  async function loadNeighborhood(nodeId: string) {
    const cy = cyRef.current;
    if (!cy) return;
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Loading…');
    try {
      const res = await apiFetch(
        `/api/kg/graph?node_id=${encodeURIComponent(nodeId)}&depth=2`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[]; edges: ApiKgEdge[] };
      if (cy.destroyed()) return;
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
      setStatus(`${data.nodes.length} nodes · ${data.edges.length} edges`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] neighborhood load failed:', err);
      setStatus('Failed to load');
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
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[]; edges: ApiKgEdge[] };

      const newNodes = data.nodes.filter(n => !cy.getElementById(n.id).length);
      const newEdges = data.edges.filter(e => !cy.getElementById(e.id).length);
      const newElements = [...newNodes.map(nodeToElement), ...newEdges.map(edgeToElement)];

      if (cy.destroyed()) return;

      if (newElements.length > 0) {
        cy.add(newElements);
        updateDegrees(cy);
        applyColorMode(cy, colorModeRef.current);
        // randomize: false warms fCoSE from current positions without hard-pinning
        // existing nodes, so the graph re-settles globally instead of squeezing
        // new nodes into whatever gaps remain.
        cy.layout(FCOSE_EXPAND as unknown as cytoscape.LayoutOptions).run();
      }

      cy.elements().removeClass('focal');
      cy.getElementById(nodeId).addClass('focal');

      setStatus(`${cy.nodes().length} nodes · ${cy.edges().length} edges`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] expand failed:', err);
      setStatus('Failed to expand');
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
      // focal class, viewport centering, and URL sync in one shot.
      void loadNeighborhood(initialNode);
    } else {
      // Default view: focus on the principal's KG node so the graph opens on
      // a meaningful starting point. Falls back to the hero graph if the
      // principal has no linked KG node or the contacts fetch fails.
      void (async () => {
        try {
          const res = await apiFetch('/api/kg/contacts');
          if (res.ok) {
            const contacts = await res.json() as Array<{
              systemRole: string | null;
              kgNodeId: string | null;
            }>;
            const principal = contacts.find(c => c.systemRole === 'principal');
            if (principal?.kgNodeId) {
              await loadNeighborhood(principal.kgNodeId);
              return;
            }
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

  // ── Sidebar search ─────────────────────────────────────────────────────────

  function handleSearch(q: string) {
    setSearch(q);
    searchRef.current = q;
  }

  function submitSearch() {
    syncUrl(search, selectedNode?.id);
    void loadSidebarNodes(search);
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

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>
              {loadError}
            </div>
          ) : (
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
                <div className="kg-sidebar-list">
                  {sidebarNodes.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: 0 }}>
                      No matching nodes.
                    </p>
                  ) : (
                    sidebarNodes.map(node => (
                      <button
                        key={node.id}
                        className="kg-node-card"
                        onClick={() => void loadNeighborhood(node.id)}
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
                <div className="kg-canvas" ref={containerRef} />
              </div>

              {/* Right: node detail drawer (conditional) */}
              {selectedNode && (
                <NodeDetailDrawer
                  key={selectedNode.id}
                  node={selectedNode}
                  onClose={handleDrawerClose}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
