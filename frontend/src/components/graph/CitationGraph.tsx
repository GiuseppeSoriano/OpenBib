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
import { nodeRadius, nodeStyle, type NodeStyleColors } from "@/components/graph/nodeStyle";
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
  /**
   * Nodes labelled at every zoom level, over a background halo, besides the
   * selected, hovered and pinned ones (which always are).
   */
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
/** Other papers are labelled from this zoom up, where they have room. */
const LABEL_ZOOM = 1.3;
/** Time for papers that just arrived to spread before the automatic fit. */
const AUTO_FIT_DELAY = 900;
/** Pointer travel (px) that counts as the user panning or dragging. */
const DRAG_SLOP = 4;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function citations(node: ForceNode): number {
  return node.node.selected_version.cited_by_count ?? 0;
}

function radiusOf(node: ForceNode): number {
  return nodeRadius(node.node.selected_version.cited_by_count);
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
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
  const hoveredRef = useRef<string | null>(null);
  // Whether the user panned or zoomed the view themselves (wheel, drag,
  // pinch, the zoom buttons) since the last fit.
  const interactedRef = useRef(false);
  // The view is fitted once, after the first range or top-up adds papers.
  const autoFitRef = useRef({ baseline: data.nodes.length, done: false });
  const autoFitTimerRef = useRef<number | undefined>(undefined);
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
    fg.d3Force("collide", forceCollide((node: ForceNode) => radiusOf(node) + 8).iterations(2));
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

  const fitView = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    interactedRef.current = false;
    fg.zoomToFit(400, 60);
    // A graph of one or two papers would otherwise be zoomed until a node
    // fills the screen; cap the fitted zoom so nodes keep their scale.
    window.setTimeout(() => {
      if (fgRef.current && fgRef.current.zoom() > MAX_FIT_ZOOM) {
        fgRef.current.zoom(MAX_FIT_ZOOM, 200);
      }
    }, 420);
  }, []);

  // The user's own pans and zooms (wheel, a drag on the canvas or a node,
  // a pinch). Programmatic moves raise no pointer events, so they never count.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    const onWheel = () => {
      interactedRef.current = true;
    };
    const onDown = (event: PointerEvent) => {
      start = { x: event.clientX, y: event.clientY };
    };
    const onMove = (event: PointerEvent) => {
      if (!start || !event.buttons) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP) interactedRef.current = true;
    };
    const onUp = () => {
      start = null;
    };
    const options = { capture: true, passive: true };
    el.addEventListener("wheel", onWheel, options);
    el.addEventListener("pointerdown", onDown, options);
    el.addEventListener("pointermove", onMove, options);
    el.addEventListener("pointerup", onUp, options);
    el.addEventListener("pointercancel", onUp, options);
    return () => {
      el.removeEventListener("wheel", onWheel, options);
      el.removeEventListener("pointerdown", onDown, options);
      el.removeEventListener("pointermove", onMove, options);
      el.removeEventListener("pointerup", onUp, options);
      el.removeEventListener("pointercancel", onUp, options);
    };
  }, []);

  // Fit once when the first range or top-up adds papers to the base graph,
  // after they have had a moment to spread, unless the user has moved the
  // view since: a view fitted to a single seed is far too close for a range.
  useEffect(() => {
    const auto = autoFitRef.current;
    if (auto.done || data.nodes.length <= auto.baseline) return;
    auto.done = true;
    if (interactedRef.current) return;
    autoFitTimerRef.current = window.setTimeout(() => {
      if (!interactedRef.current) fitView();
    }, AUTO_FIT_DELAY);
  }, [data, fitView]);
  useEffect(() => () => window.clearTimeout(autoFitTimerRef.current), []);

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const fg = fgRef.current;
      interactedRef.current = true;
      if (fg) fg.zoom(fg.zoom() * 1.4, 250);
    },
    zoomOut: () => {
      const fg = fgRef.current;
      interactedRef.current = true;
      if (fg) fg.zoom(fg.zoom() / 1.4, 250);
    },
    fit: fitView,
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
      const r = radiusOf(node);
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
    },
    [colors, pinnedIds, savedGroupKeys, selectedId],
  );

  // Titles (serif, like every paper title), drawn after every node so they
  // sit on top. The selected and hovered papers are always labelled, over a
  // halo so they read across edges (the selection's in its amber). Pinned
  // papers come next, at every zoom and also over a halo, then the others
  // only from LABEL_ZOOM up, most cited first; a pinned or other label that
  // would overlap one already drawn is skipped (a collection graph pins
  // every paper, so its titles would otherwise pile up when zoomed out).
  const drawLabels = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      const px = 1 / globalScale;
      // Lay the text out at 12px and scale the context instead: a tiny font
      // size scaled up by the zoom gets uneven glyph spacing.
      const k = Math.max(12 * px, 3) / 12;
      const hovered = hoveredRef.current;
      const rank = (id: string) => {
        if (id === selectedId) return 0;
        if (id === hovered) return 1;
        return pinnedIds.has(id) || alwaysLabelIds.has(id) ? 2 : 3;
      };
      const queue = dataRef.current.nodes
        .map((node) => ({ node, rank: rank(node.id) }))
        .filter((entry) => entry.rank < 3 || globalScale >= LABEL_ZOOM)
        .sort((a, b) => a.rank - b.rank || citations(b.node) - citations(a.node));
      const drawn: Box[] = [];
      ctx.save();
      ctx.font = `12px ${colors.labelFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      for (const { node, rank: level } of queue) {
        const label = truncateLabel(paperTitle(node.node.selected_version, t));
        const x = node.x ?? 0;
        const selected = node.id === selectedId;
        const labelY = (node.y ?? 0) + radiusOf(node) + (selected ? 10 * px : 3 * px);
        const width = ctx.measureText(label).width * k;
        const box = { x: x - width / 2 - 2 * px, y: labelY - px, w: width + 4 * px, h: 15 * k + 2 * px };
        if (level >= 2 && drawn.some((other) => overlaps(box, other))) continue;
        drawn.push(box);
        ctx.save();
        ctx.translate(x, labelY);
        ctx.scale(k, k);
        if (level < 3) {
          ctx.lineWidth = (3 * px) / k;
          ctx.strokeStyle = colors.canvas;
          ctx.strokeText(label, 0, 0);
        }
        ctx.fillStyle = selected ? colors.selectedLabel : colors.label;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    },
    [alwaysLabelIds, colors, pinnedIds, selectedId, t],
  );

  // A hover labels its paper; once the layout has settled the canvas only
  // redraws on a view change, so a same-scale zoom asks for one frame.
  const handleNodeHover = useCallback((node: ForceNode | null) => {
    const id = node?.id ?? null;
    if (hoveredRef.current === id) return;
    hoveredRef.current = id;
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom());
  }, []);

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
        nodeVal={(node: ForceNode) => radiusOf(node) ** 2 / 4}
        nodeLabel={(node: ForceNode) => { const label = document.createElement("span"); label.textContent = paperTitle(node.node.selected_version, t); return label.outerHTML; }}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={(node: ForceNode, color, ctx) => {
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, radiusOf(node) + 4, 0, 2 * Math.PI);
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
        onNodeHover={handleNodeHover}
        onRenderFramePost={drawLabels}
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
