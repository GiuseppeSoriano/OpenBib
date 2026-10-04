import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import { useTranslation } from "react-i18next";
import type { ForceGraphData, ForceLink, ForceNode } from "@/components/graph/mergeGraph";
import { nodeStyle, type NodeStyleColors } from "@/components/graph/nodeStyle";
import { paperTitle, truncateLabel } from "@/components/graph/paperText";

export interface CitationGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  reheat: () => void;
  /** Center the view on a node (the list's keyboard path to the canvas). */
  focusNode: (id: string) => void;
  /** Fix a node where it currently is. */
  pinNode: (id: string) => void;
  /** Release a node's fixed position and let the layout settle again. */
  unpinNode: (id: string) => void;
}

interface CitationGraphProps {
  data: ForceGraphData;
  selectedId: string | null;
  /** paper_group_keys saved in the user's library. */
  savedGroupKeys?: ReadonlySet<string>;
  pinnedIds?: ReadonlySet<string>;
  /** Nodes labelled at every zoom level, over a background halo. */
  alwaysLabelIds?: ReadonlySet<string>;
  /** Accessible name of the canvas (it is exposed as one image). */
  ariaLabel: string;
  onNodeClick: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
  onBackgroundClick: () => void;
  /** A drag ended: the node is now fixed where it was dropped. */
  onNodeDragPin?: (id: string) => void;
}

interface ThemeStyle extends NodeStyleColors {
  edge: string;
  label: string;
  /** The selected paper's label (the amber of the selection ring, as text). */
  selectedLabel: string;
  /** --graph-canvas: the halo behind always-on labels. */
  canvas: string;
  /** Canvas has no var() support, so the label stack is resolved up front. */
  labelFont: string;
}

/** Opacity of the soft halo around the selection ring (--graph-node-halo). */
const HALO_ALPHA = 0.18;

const EMPTY_IDS: ReadonlySet<string> = new Set();

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolves the canvas colors from the theme tokens. Fallbacks are the
 * light-theme Verdigris values, used only where the custom properties fail
 * to resolve. (The halo's color-mix() is not read: the canvas draws the ring
 * colour at HALO_ALPHA instead, which needs no colour parsing.)
 */
function readThemeColors(): ThemeStyle {
  const canvas = cssVar("--graph-canvas") || cssVar("--color-bg") || "#f8faf9";
  return {
    node: cssVar("--graph-node") || "#a0a8a4",
    pinned: cssVar("--graph-node-pinned") || cssVar("--color-accent") || "#33695f",
    saved: cssVar("--graph-node-saved") || cssVar("--color-success") || "#46689b",
    selected: cssVar("--graph-node-selected") || cssVar("--color-warning") || "#8f5b14",
    background: cssVar("--graph-node-gap") || canvas,
    edge: cssVar("--graph-edge") || "#d6dcd8",
    label: cssVar("--color-text") || "#1a1e1d",
    selectedLabel: cssVar("--color-state-toread-text") || "#7a4d11",
    canvas,
    labelFont: cssVar("--font-serif") || "Georgia, serif",
  };
}

const MAX_FIT_ZOOM = 2.5;

function nodeRadius(node: ForceNode): number {
  const citations = node.node.selected_version.cited_by_count ?? 0;
  return 3 + 1.8 * Math.log2(1 + citations);
}

/**
 * Obsidian-style force-directed citation graph: a continuous d3-force
 * simulation on canvas. Existing nodes keep their positions across range
 * loads (object identity in mergeGraph). Pinned nodes are fixed in place:
 * dragging pins a node, and seeds freeze once the first layout settles.
 */
const CitationGraph = forwardRef<CitationGraphHandle, CitationGraphProps>(function CitationGraph(
  {
    data,
    selectedId,
    savedGroupKeys = EMPTY_IDS,
    pinnedIds = EMPTY_IDS,
    alwaysLabelIds = EMPTY_IDS,
    ariaLabel,
    onNodeClick,
    onNodeDoubleClick,
    onBackgroundClick,
    onNodeDragPin,
  },
  ref,
) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const lastClickRef = useRef<{ id: string; time: number }>({ id: "", time: 0 });
  // Latest data and pins for the stable handle and engine callbacks.
  const dataRef = useRef(data);
  const pinnedRef = useRef(pinnedIds);
  const frozenRef = useRef(false);
  dataRef.current = data;
  pinnedRef.current = pinnedIds;

  // Track the container size so the canvas always fills it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Physics: collision keeps nodes from heaping; a stronger (but
  // range-limited) charge and short links spread new ranges readably.
  // Forces persist across data updates — force-graph re-initializes them
  // with the new node array on every graphData change.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // Tuned live: 25-node expansions settle to a readable ~350px cluster
    // with no overlaps instead of a heap on the seed.
    fg.d3Force("collide", forceCollide((node: ForceNode) => nodeRadius(node) + 8).iterations(2));
    const charge = fg.d3Force("charge");
    if (charge) {
      charge.strength(-160);
      charge.distanceMax?.(420);
    }
    const link = fg.d3Force("link");
    if (link) {
      // Weak long links: d3's default link strength (1/min-degree) yanks
      // leaf nodes onto a tiny ring around hubs; letting charge dominate
      // spaces big ranges readably.
      link.distance?.(90);
      link.strength?.(0.25);
    }
  }, []);

  // Theme colors, re-read whenever <html data-theme> changes; the canvas
  // re-draws every frame so nodes/edges restyle instantly. The attribute is
  // observed rather than the theme context: ThemeProvider writes it in an
  // effect that runs after this component renders, so reading the tokens on
  // the context change would still see the previous theme.
  const [colors, setColors] = useState<ThemeStyle>(readThemeColors);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(readThemeColors()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const findNode = (id: string) => dataRef.current.nodes.find((node) => node.id === id);

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const fg = fgRef.current;
      if (fg) fg.zoom(fg.zoom() * 1.4, 250);
    },
    zoomOut: () => {
      const fg = fgRef.current;
      if (fg) fg.zoom(fg.zoom() / 1.4, 250);
    },
    fit: () => {
      const fg = fgRef.current;
      if (!fg) return;
      fg.zoomToFit(400, 60);
      // A graph of one or two papers would otherwise be zoomed until a node
      // fills the screen; cap the fitted zoom so nodes keep their scale.
      window.setTimeout(() => {
        if (fgRef.current && fgRef.current.zoom() > MAX_FIT_ZOOM) {
          fgRef.current.zoom(MAX_FIT_ZOOM, 200);
        }
      }, 420);
    },
    reheat: () => fgRef.current?.d3ReheatSimulation(),
    focusNode: (id: string) => {
      const fg = fgRef.current;
      const node = findNode(id);
      if (!fg || node?.x === undefined || node.y === undefined) return;
      fg.centerAt(node.x, node.y, 400);
      if (fg.zoom() < 1.5) fg.zoom(2, 400);
    },
    pinNode: (id: string) => {
      const node = findNode(id);
      if (!node) return;
      node.fx = node.x;
      node.fy = node.y;
    },
    unpinNode: (id: string) => {
      const node = findNode(id);
      if (!node) return;
      delete node.fx;
      delete node.fy;
      fgRef.current?.d3ReheatSimulation();
    },
  }));

  // Seeds start pinned but unplaced: fix every node that is still pinned
  // where the first layout left it. Later settles never move pins again.
  const handleEngineStop = useCallback(() => {
    if (frozenRef.current) return;
    frozenRef.current = true;
    for (const node of dataRef.current.nodes) {
      if (!pinnedRef.current.has(node.id) || node.fx !== undefined || node.fy !== undefined) continue;
      node.fx = node.x;
      node.fy = node.y;
    }
  }, []);

  // The current view, as rounded data attributes (CSP-safe, no styles), so
  // tests and audits can check that overlays never move the graph.
  const recordView = useCallback((view: { k: number; x: number; y: number }) => {
    const el = containerRef.current;
    if (!el) return;
    el.dataset.zoom = view.k.toFixed(2);
    el.dataset.cx = String(Math.round(view.x));
    el.dataset.cy = String(Math.round(view.y));
  }, []);

  // Dev-only: expose live graph data for in-browser physics verification.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__openbibGraph = data;
      w.__openbibFg = fgRef.current;
    }
  }, [data]);

  const drawNode = useCallback(
    (node: ForceNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = nodeRadius(node);
      const px = 1 / globalScale;
      const style = nodeStyle(
        node.node,
        { pinned: pinnedIds.has(node.id), saved: savedGroupKeys.has(node.id), selected: node.id === selectedId },
        colors,
      );

      // Every node, pinned and selected ones included, is a plain filled
      // circle in its state colour; selection only adds the ring below.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = style.fill;
      ctx.fill();

      // Dashed ring marks multi-version groups.
      if (style.versionRing) {
        ctx.beginPath();
        ctx.setLineDash([2, 2]);
        ctx.arc(x, y, r + 1.5, 0, 2 * Math.PI);
        ctx.strokeStyle = style.fill;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Selection, outside the node: a soft halo, then a 3px amber ring held
      // clear of the fill by a canvas-coloured gap, readable on both themes.
      if (style.selectedRing) {
        ctx.beginPath();
        ctx.arc(x, y, r + 7.5 * px, 0, 2 * Math.PI);
        ctx.strokeStyle = style.selectedRing.color;
        ctx.lineWidth = 3 * px;
        ctx.globalAlpha = HALO_ALPHA;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5 * px, 0, 2 * Math.PI);
        ctx.strokeStyle = style.selectedRing.color;
        ctx.lineWidth = 3 * px;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5 * px, 0, 2 * Math.PI);
        ctx.strokeStyle = style.selectedRing.gapColor;
        ctx.lineWidth = 3 * px;
        ctx.stroke();
      }

      // Titles (serif, like every paper title) fade in as the user zooms;
      // the selection and a few pins are always labelled, over a halo so
      // they read on top of edges. The selection's label takes its amber.
      const always = alwaysLabelIds.has(node.id);
      if (always || globalScale > 1.3) {
        const label = truncateLabel(paperTitle(node.node.selected_version, t));
        // Lay the text out at 12px and scale the context instead: a tiny font
        // size scaled up by the zoom gets uneven glyph spacing.
        const k = Math.max(12 * px, 3) / 12;
        const labelY = y + r + (style.selectedRing ? 10 * px : 3 * px);
        ctx.save();
        ctx.translate(x, labelY);
        ctx.scale(k, k);
        ctx.font = `12px ${colors.labelFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (always) {
          ctx.lineJoin = "round";
          ctx.lineWidth = (3 * px) / k;
          ctx.strokeStyle = colors.canvas;
          ctx.strokeText(label, 0, 0);
        }
        ctx.fillStyle = style.selectedRing ? colors.selectedLabel : colors.label;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    },
    [alwaysLabelIds, colors, pinnedIds, savedGroupKeys, selectedId, t],
  );

  const handleNodeClick = useCallback(
    (node: ForceNode) => {
      const now = Date.now();
      const last = lastClickRef.current;
      if (onNodeDoubleClick && last.id === node.id && now - last.time < 350) {
        lastClickRef.current = { id: "", time: 0 };
        onNodeDoubleClick(node.id);
        return;
      }
      lastClickRef.current = { id: node.id, time: now };
      onNodeClick(node.id);
    },
    [onNodeClick, onNodeDoubleClick],
  );

  const handleDragEnd = useCallback(
    (node: ForceNode) => {
      // Dragging pins the node exactly where the user dropped it.
      node.fx = node.x;
      node.fy = node.y;
      onNodeDragPin?.(node.id);
    },
    [onNodeDragPin],
  );

  return (
    <div
      ref={containerRef}
      className="graph-canvas-container"
      data-testid="citation-graph"
      role="img"
      aria-label={ariaLabel}
    >
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        nodeId="id"
        nodeVal={(node: ForceNode) => nodeRadius(node) ** 2 / 4}
        nodeLabel={(node: ForceNode) => { const label = document.createElement("span"); label.textContent = paperTitle(node.node.selected_version, t); return label.outerHTML; }}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={(node: ForceNode, color, ctx) => {
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node) + 4, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkColor={() => colors.edge}
        linkWidth={1}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0}
        d3AlphaDecay={0.028}
        d3VelocityDecay={0.35}
        cooldownTime={5000}
        onNodeClick={handleNodeClick}
        onBackgroundClick={onBackgroundClick}
        onNodeDragEnd={handleDragEnd}
        onEngineStop={handleEngineStop}
        onZoomEnd={recordView}
        enableNodeDrag
      />
    </div>
  );
});

export default CitationGraph;
export type { ForceGraphData, ForceLink, ForceNode };
