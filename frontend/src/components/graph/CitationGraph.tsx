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
import { endpointId, type ForceGraphData, type ForceLink, type ForceNode } from "@/components/graph/mergeGraph";
import { markRadius, nodeRadius, nodeStyle, type NodeStyleColors } from "@/components/graph/nodeStyle";
import { nodeTitle, truncateLabel, wrapLabel } from "@/components/graph/paperText";
import { centreFor, freeArea, type Rect } from "@/components/graph/viewGeometry";

export interface CitationGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  reheat: () => void;
  /**
   * Center the view on a node (the list's keyboard path to the canvas),
   * within the part of the canvas the overlays leave free.
   */
  focusNode: (id: string) => void;
  /** Fix a node where it currently is. */
  pinNode: (id: string) => void;
  /** Release a node's fixed position and let the layout settle again. */
  unpinNode: (id: string) => void;
}

interface CitationGraphProps {
  data: ForceGraphData;
  /**
   * Changes whenever node payloads may have changed in place (a title that
   * arrived): the canvas repaints without the new data a re-heat needs.
   */
  payloadRevision?: number;
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
  /**
   * Elements floating over the canvas (the selected-paper card, a sheet):
   * focusing a node keeps it clear of them.
   */
  getOverlays?: () => readonly Element[];
}

interface ThemeStyle extends NodeStyleColors {
  /** --graph-edge: a link's line. */
  edge: string;
  /** --graph-edge-arrow: a link's arrowhead. */
  edgeArrow: string;
  /** --graph-edge-active: the focused paper's links, line and arrowhead. */
  edgeActive: string;
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
    node: cssVar("--graph-node") || "#858f8a",
    pinned: cssVar("--graph-node-pinned") || cssVar("--color-accent") || "#33695f",
    mark: cssVar("--graph-node-mark") || canvas,
    selected: cssVar("--graph-node-selected") || cssVar("--color-warning") || "#8f5b14",
    background: cssVar("--graph-node-gap") || canvas,
    edge: cssVar("--graph-edge") || "#bac2be",
    edgeArrow: cssVar("--graph-edge-arrow") || "#858f8b",
    edgeActive: cssVar("--graph-edge-active") || "#4f5a56",
    label: cssVar("--color-text") || "#1a1e1d",
    selectedLabel: cssVar("--color-state-toread-text") || "#7a4d11",
    canvas,
    labelFont: cssVar("--font-serif") || "Georgia, serif",
  };
}

/**
 * Highest zoom a fit or the opening view uses: a graph of one or two papers
 * would otherwise be zoomed until a node fills the screen.
 */
const MAX_FIT_ZOOM = 2;
/** Other papers are labelled from this zoom up, where they have room. */
const LABEL_ZOOM = 1.3;
/** Focusing a paper raises a lower zoom to this, and never zooms in further. */
const FOCUS_ZOOM = 1.5;
/** Time for papers that just arrived to spread before the automatic fit. */
const AUTO_FIT_DELAY = 900;
/** Pointer travel (px) that counts as the user panning or dragging. */
const DRAG_SLOP = 4;
/** A label line's height, at the 12px the labels are laid out in. */
const LABEL_LINE_HEIGHT = 15;

// Links, in screen px at every zoom: a 1px line held 2px clear of both
// circles, with one arrowhead (7 long, 6 wide) halfway along it, its tip
// 3.5px past the midpoint so the head sits centred on it. A link shorter
// than ARROW_MIN_SEGMENT between its circles keeps only the line.
const LINK_WIDTH = 1;
const LINK_GAP = 2;
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 3;
const ARROW_TIP_OFFSET = 3.5;
const ARROW_MIN_SEGMENT = 18;

/**
 * The engine's own line for the links it paints before ours (the focused
 * paper's, see linkMode): transparent, so only the drawn link shows.
 */
const ENGINE_LINK_COLOR = () => "rgba(0,0,0,0)";
/** Links are not pointer targets: no hover, no tooltip, no click. */
const NO_LINK_POINTER_AREA = () => undefined;
/**
 * No engine tooltip on a hovered paper either: its own canvas label shows
 * the title (whole, where one line would cut it). Left unset, the engine
 * would look for one in a `name` field.
 */
const NO_NODE_TOOLTIP = () => "";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A label's place: its centre's x and its top's y. */
type Spot = [number, number];

/** A side of a paper: where a label's first line goes, and the whole label. */
interface Slot {
  line: Spot;
  full: Spot;
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

/** Whether a link touches the focused paper (none when nothing is focused). */
function touchesFocus(link: ForceLink, focusId: string | null): boolean {
  return focusId !== null && (endpointId(link.source) === focusId || endpointId(link.target) === focusId);
}

/**
 * One citation link, from the citing paper (source) to the cited one
 * (target): a straight line between the two circles' edges and a filled
 * arrowhead halfway along it, pointing at the cited paper. Sizes are in
 * screen px (divided by the zoom), so they hold at every zoom.
 */
function paintLink(
  ctx: CanvasRenderingContext2D,
  source: ForceNode,
  target: ForceNode,
  globalScale: number,
  line: string,
  arrow: string,
) {
  const ax = source.x;
  const ay = source.y;
  const bx = target.x;
  const by = target.y;
  if (ax === undefined || ay === undefined || bx === undefined || by === undefined) return;
  const px = 1 / globalScale;
  const length = Math.hypot(bx - ax, by - ay);
  // Distances along the link, from the citing paper's centre.
  const start = radiusOf(source) + LINK_GAP * px;
  const end = length - radiusOf(target) - LINK_GAP * px;
  // Circles touching or overlapping: nothing shows between them.
  if (end <= start) return;
  const ux = (bx - ax) / length;
  const uy = (by - ay) / length;
  ctx.beginPath();
  ctx.moveTo(ax + ux * start, ay + uy * start);
  ctx.lineTo(ax + ux * end, ay + uy * end);
  ctx.strokeStyle = line;
  ctx.lineWidth = LINK_WIDTH * px;
  ctx.stroke();
  if ((end - start) * globalScale < ARROW_MIN_SEGMENT) return;
  const tip = (start + end) / 2 + ARROW_TIP_OFFSET * px;
  const tipX = ax + ux * tip;
  const tipY = ay + uy * tip;
  const baseX = tipX - ux * ARROW_LENGTH * px;
  const baseY = tipY - uy * ARROW_LENGTH * px;
  const half = ARROW_HALF_WIDTH * px;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX - uy * half, baseY + ux * half);
  ctx.lineTo(baseX + uy * half, baseY - ux * half);
  ctx.closePath();
  ctx.fillStyle = arrow;
  ctx.fill();
}

/** Whether a circle (a node, with some clearance) reaches into a label's box. */
function circleHits(cx: number, cy: number, r: number, box: Box): boolean {
  const dx = cx - Math.min(Math.max(cx, box.x), box.x + box.w);
  const dy = cy - Math.min(Math.max(cy, box.y), box.y + box.h);
  return dx * dx + dy * dy < r * r;
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
    payloadRevision = 0,
    selectedId,
    savedGroupKeys = EMPTY_IDS,
    pinnedIds = EMPTY_IDS,
    alwaysLabelIds = EMPTY_IDS,
    ariaLabel,
    onNodeClick,
    onNodeDoubleClick,
    onBackgroundClick,
    onNodeDragPin,
    getOverlays,
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
  // The paper the drawing treats as hovered (see applyHover), and the one
  // the engine last reported under the pointer.
  const hoveredRef = useRef<string | null>(null);
  const engineHoveredRef = useRef<string | null>(null);
  // The kind of pointer last seen on the canvas: the engine reports the
  // paper under a touch as hovered, but a touch screen has no hover.
  const pointerTypeRef = useRef("mouse");
  // Whether the pointer is over the canvas: the engine keeps reporting the
  // paper it last saw under it once it has left (for a card, the legend or
  // the papers panel).
  const pointerInsideRef = useRef(true);
  // Whether the user panned or zoomed the view themselves (wheel, drag,
  // pinch, the zoom buttons) since the last fit.
  const interactedRef = useRef(false);
  // The view is fitted once, after the first range or top-up adds papers.
  const autoFitRef = useRef({ baseline: data.nodes.length, done: false });
  const autoFitTimerRef = useRef<number | undefined>(undefined);
  // The engine opens at a zoom that grows as the graph shrinks (a lone seed
  // at 4x); the first such view is held to MAX_FIT_ZOOM, until the view is
  // fitted, focused or moved by the user.
  const capOpeningZoomRef = useRef(true);
  const overlaysRef = useRef(getOverlays);
  dataRef.current = data;
  pinnedRef.current = pinnedIds;
  overlaysRef.current = getOverlays;

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
    capOpeningZoomRef.current = false;
    fg.zoomToFit(400, 60);
    // A graph of one or two papers would otherwise be zoomed until a node
    // fills the screen; cap the fitted zoom so nodes keep their scale.
    window.setTimeout(() => {
      if (fgRef.current && fgRef.current.zoom() > MAX_FIT_ZOOM) {
        fgRef.current.zoom(MAX_FIT_ZOOM, 200);
      }
    }, 420);
  }, []);

  // The hover the drawing shows: the engine's, while a mouse (or pen) is
  // over the canvas. A touch is never a hover: the tapped paper is selected
  // instead. Once the layout has settled the canvas only redraws on a view
  // change, so a same-scale zoom asks for one frame.
  const applyHover = useCallback(() => {
    const id = pointerInsideRef.current && pointerTypeRef.current !== "touch" ? engineHoveredRef.current : null;
    if (hoveredRef.current === id) return;
    hoveredRef.current = id;
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom());
  }, []);

  // The user's own pans and zooms (wheel, a drag on the canvas or a node,
  // a pinch). Programmatic moves raise no pointer events, so they never count.
  // The capture phase also notes the pointer's kind before the engine,
  // which picks the hovered paper on its next frame, sees the event; the
  // engine reports no change for the paper it already had, so the hover is
  // worked out again here (a mouse after a touch, a pointer back in).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    const onWheel = () => {
      interactedRef.current = true;
    };
    const onDown = (event: PointerEvent) => {
      pointerTypeRef.current = event.pointerType;
      pointerInsideRef.current = true;
      applyHover();
      start = { x: event.clientX, y: event.clientY };
    };
    const onMove = (event: PointerEvent) => {
      pointerTypeRef.current = event.pointerType;
      pointerInsideRef.current = true;
      applyHover();
      if (!start || !event.buttons) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP) interactedRef.current = true;
    };
    const onUp = () => {
      start = null;
    };
    // The pointer left the canvas itself (leaving one of its own layers
    // reaches here too, in the capture phase).
    const onLeave = (event: PointerEvent) => {
      if (event.target !== el) return;
      pointerInsideRef.current = false;
      applyHover();
    };
    const options = { capture: true, passive: true };
    el.addEventListener("wheel", onWheel, options);
    el.addEventListener("pointerdown", onDown, options);
    el.addEventListener("pointermove", onMove, options);
    el.addEventListener("pointerup", onUp, options);
    el.addEventListener("pointercancel", onUp, options);
    el.addEventListener("pointerleave", onLeave, options);
    return () => {
      el.removeEventListener("wheel", onWheel, options);
      el.removeEventListener("pointerdown", onDown, options);
      el.removeEventListener("pointermove", onMove, options);
      el.removeEventListener("pointerup", onUp, options);
      el.removeEventListener("pointercancel", onUp, options);
      el.removeEventListener("pointerleave", onLeave, options);
    };
  }, [applyHover]);

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
      capOpeningZoomRef.current = false;
      // The selection's card renders with this update: measure the overlays
      // on the next frame, once it is in place.
      window.requestAnimationFrame(() => {
        const fg = fgRef.current;
        const el = containerRef.current;
        const node = findNode(id);
        if (!fg || !el || node?.x === undefined || node.y === undefined) return;
        // A moderate zoom at most: far enough in to read the paper's
        // neighbourhood, never so far that the graph slides under the card.
        const k = Math.max(fg.zoom(), FOCUS_ZOOM);
        const box = el.getBoundingClientRect();
        const canvas = { width: el.clientWidth, height: el.clientHeight };
        const overlays: Rect[] = (overlaysRef.current?.() ?? []).map((overlay) => {
          const rect = overlay.getBoundingClientRect();
          return { left: rect.left - box.left, top: rect.top - box.top, right: rect.right - box.left, bottom: rect.bottom - box.top };
        });
        const free = freeArea({ left: 0, top: 0, right: canvas.width, bottom: canvas.height }, overlays);
        const centre = centreFor({ x: node.x, y: node.y }, k, canvas, free);
        fg.centerAt(centre.x, centre.y, 400);
        if (k !== fg.zoom()) fg.zoom(k, 400);
      });
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
  // tests and audits can check that overlays never move the graph. The
  // engine's opening view is capped here too, as the engine reports it.
  const recordView = useCallback((view: { k: number; x: number; y: number }) => {
    const el = containerRef.current;
    if (!el) return;
    el.dataset.zoom = view.k.toFixed(2);
    el.dataset.cx = String(Math.round(view.x));
    el.dataset.cy = String(Math.round(view.y));
    if (!capOpeningZoomRef.current) return;
    if (interactedRef.current) capOpeningZoomRef.current = false;
    else if (view.k > MAX_FIT_ZOOM) {
      capOpeningZoomRef.current = false;
      // Reported back through this handler with the capped view.
      fgRef.current?.zoom(MAX_FIT_ZOOM);
    }
  }, []);

  // Dev-only: expose live graph data for in-browser physics verification.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__openbibGraph = data;
      w.__openbibFg = fgRef.current;
    }
  }, [data]);

  // A new drawNode makes the engine repaint (without re-heating): it also
  // changes with the payload revision, so titles swapped into the existing
  // node objects show on the next frame even once the layout has settled.
  const drawNode = useCallback(
    (node: ForceNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      void payloadRevision;
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

      // A paper in the Library: a centre dot punched through the fill.
      if (style.mark) {
        ctx.beginPath();
        ctx.arc(x, y, markRadius(r, globalScale), 0, 2 * Math.PI);
        ctx.fillStyle = style.mark;
        ctx.fill();
      }

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
    [colors, payloadRevision, pinnedIds, savedGroupKeys, selectedId],
  );

  // Links are drawn here, not by the engine. The focused paper (the hovered
  // one, else the selection) has its links in the active shade, at the same
  // width and arrow size as the rest: they go in the engine's "after" pass,
  // so they sit on top of the others. Like a hover, a new selection only
  // repaints (the painters are not graph data, so the layout never re-heats).
  const linkMode = useCallback(
    (link: ForceLink) => (touchesFocus(link, hoveredRef.current ?? selectedId) ? "after" : "replace"),
    [selectedId],
  );

  const drawLink = useCallback(
    (link: ForceLink, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const { source, target } = link;
      // The engine resolves string endpoints to its nodes once it has the data.
      if (typeof source !== "object" || typeof target !== "object") return;
      const active = touchesFocus(link, hoveredRef.current ?? selectedId);
      paintLink(
        ctx,
        source,
        target,
        globalScale,
        active ? colors.edgeActive : colors.edge,
        active ? colors.edgeActive : colors.edgeArrow,
      );
    },
    [colors, selectedId],
  );

  // Titles (serif, like every paper title), drawn after every node so they
  // sit on top. The hovered and selected papers are always labelled, over a
  // halo so they read across edges (the selection's in its amber). Pinned
  // papers come next, at every zoom and also over a halo, then the others
  // only from LABEL_ZOOM up, most cited first; a pinned or other label that
  // would overlap one already drawn is skipped (a collection graph pins
  // every paper, so its titles would otherwise pile up when zoomed out).
  // The others are also skipped where they would run across another
  // paper's circle (or the selection's ring). A pinned, selected or hovered
  // title that would cross one below its paper moves above, right or left
  // of it, to the first free side; a pin's with no free side is skipped too
  // (the list and a hover still name it), the hover's never.
  // The hovered paper's title is placed first and painted last, on top:
  // where one line would cut it, it is spelled out whole on up to three
  // lines, grown from the side its one line takes (above the paper, up from
  // it), or from another side where the canvas's edge would cut it. Every
  // other label keeps clear of it, the selection's included: that one moves
  // aside, or is left out only until the hover ends.
  const drawLabels = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      const px = 1 / globalScale;
      // Lay the text out at 12px and scale the context instead: a tiny font
      // size scaled up by the zoom gets uneven glyph spacing.
      const k = Math.max(12 * px, 3) / 12;
      const hovered = hoveredRef.current;
      const rank = (id: string) => {
        if (id === hovered) return 0;
        if (id === selectedId) return 1;
        return pinnedIds.has(id) || alwaysLabelIds.has(id) ? 2 : 3;
      };
      const nodes = dataRef.current.nodes;
      const queue = nodes
        .map((node) => ({ node, rank: rank(node.id) }))
        .filter((entry) => entry.rank < 3 || globalScale >= LABEL_ZOOM)
        .sort((a, b) => a.rank - b.rank || citations(b.node) - citations(a.node));
      const hitsNode = (box: Box, self: ForceNode) =>
        nodes.some((other) => {
          if (other === self) return false;
          const reach = radiusOf(other) + (other.id === selectedId ? 9 : 2) * px;
          return circleHits(other.x ?? 0, other.y ?? 0, reach, box);
        });
      // Whether a box (graph units) lies within the canvas, through the
      // engine's current scale and translation.
      const onScreen = (box: Box) => {
        if (typeof ctx.getTransform !== "function" || !ctx.canvas) return true;
        const m = ctx.getTransform();
        const left = m.a * box.x + m.e;
        const top = m.d * box.y + m.f;
        return left >= 0 && top >= 0 && left + m.a * box.w <= ctx.canvas.width && top + m.d * box.h <= ctx.canvas.height;
      };
      const drawn: Box[] = [];
      const placed: { lines: string[]; x: number; y: number; halo: boolean; selected: boolean; hovered: boolean }[] = [];
      ctx.save();
      ctx.font = `12px ${colors.labelFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      for (const { node, rank: level } of queue) {
        const title = nodeTitle(node.node, t);
        const lines = level === 0 ? wrapLabel(title) : [truncateLabel(title)];
        const expanded = lines.length > 1;
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        const r = radiusOf(node);
        const selected = node.id === selectedId;
        const gap = selected ? 10 * px : 3 * px;
        const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) * k;
        const lineHeight = LABEL_LINE_HEIGHT * k;
        const height = lineHeight * lines.length;
        // A label's box, from its centre's x and its top's y, `rows` lines tall.
        const boxAt = ([cx, top]: Spot, rows = lines.length): Box => ({
          x: cx - width / 2 - 2 * px,
          y: top - px,
          w: width + 4 * px,
          h: lineHeight * rows + 2 * px,
        });
        // Clear of every label placed before it: for the selection's, that
        // is only the hovered paper's.
        const clear = (box: Box) => !drawn.some((other) => overlaps(box, other));
        // Each side of the paper a label can take: where its first line goes,
        // and where the whole label goes, grown from that line (downwards,
        // or upwards above the paper). Only a spelled-out title has more.
        const below: Slot = { line: [x, y + r + gap], full: [x, y + r + gap] };
        const right: Spot = [x + r + gap + width / 2, y - lineHeight / 2];
        const left: Spot = [x - r - gap - width / 2, y - lineHeight / 2];
        const sides: Slot[] = [
          { line: [x, y - r - gap - lineHeight], full: [x, y - r - gap - height] },
          { line: right, full: right },
          { line: left, full: left },
        ];
        // The first line alone picks the side, so a hovered title grows from
        // where its one line goes (over the circles its other lines cross);
        // the whole label has to stay on the canvas, though.
        const free = (slot: Slot) => {
          const box = boxAt(slot.line, 1);
          return !hitsNode(box, node) && clear(box);
        };
        const onCanvas = (slot: Slot) => onScreen(boxAt(slot.full));
        // An always-labelled paper whose title would cross a circle (or
        // another label) below it takes the first free room above, to the
        // right or to the left of it instead.
        // A side that runs off the canvas is only taken by a pin, and only
        // when no side on screen is free. A spelled-out title also leaves the
        // room below where the canvas's edge would cut its lines, for a side
        // on screen, across a circle if it must.
        const place =
          level < 3 && !(free(below) && (!expanded || onCanvas(below)))
            ? sides.find((side) => free(side) && onCanvas(side)) ??
              (level === 2 ? sides.find(free) : expanded ? sides.find(onCanvas) : undefined) ??
              below
            : below;
        const [labelX, labelY] = place.full;
        const box = boxAt(place.full);
        if (!clear(box)) continue;
        if (level >= 2 && hitsNode(box, node)) continue;
        drawn.push(box);
        placed.push({ lines, x: labelX, y: labelY, halo: level < 3, selected, hovered: level === 0 });
      }
      // The hovered label last, over everything else.
      placed.sort((a, b) => Number(a.hovered) - Number(b.hovered));
      for (const label of placed) {
        ctx.save();
        ctx.translate(label.x, label.y);
        ctx.scale(k, k);
        if (label.halo) {
          ctx.lineWidth = (3 * px) / k;
          ctx.strokeStyle = colors.canvas;
          label.lines.forEach((line, i) => ctx.strokeText(line, 0, i * LABEL_LINE_HEIGHT));
        }
        ctx.fillStyle = label.selected ? colors.selectedLabel : colors.label;
        label.lines.forEach((line, i) => ctx.fillText(line, 0, i * LABEL_LINE_HEIGHT));
        ctx.restore();
      }
      ctx.restore();
    },
    [alwaysLabelIds, colors, pinnedIds, selectedId, t],
  );

  // A hover labels its paper and focuses its links (see applyHover).
  const handleNodeHover = useCallback(
    (node: ForceNode | null) => {
      engineHoveredRef.current = node?.id ?? null;
      applyHover();
    },
    [applyHover],
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
        nodeVal={(node: ForceNode) => radiusOf(node) ** 2 / 4}
        nodeLabel={NO_NODE_TOOLTIP}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={(node: ForceNode, color, ctx) => {
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, radiusOf(node) + 4, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkCanvasObject={drawLink}
        linkCanvasObjectMode={linkMode}
        linkColor={ENGINE_LINK_COLOR}
        linkPointerAreaPaint={NO_LINK_POINTER_AREA}
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
