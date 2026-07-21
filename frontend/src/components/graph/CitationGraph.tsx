import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import { useTheme } from "@/contexts/ThemeContext";
import type { ForceGraphData, ForceLink, ForceNode } from "@/components/graph/mergeGraph";

export interface CitationGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  reheat: () => void;
}

interface CitationGraphProps {
  data: ForceGraphData;
  selectedId: string | null;
  /** paper_group_keys saved in the user's library (colored green). */
  savedGroupKeys?: Set<string>;
  onNodeClick: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
  onBackgroundClick: () => void;
}

interface ThemeColors {
  node: string;
  seed: string;
  saved: string;
  edge: string;
  label: string;
  halo: string;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function nodeRadius(node: ForceNode): number {
  const citations = node.node.selected_version.cited_by_count ?? 0;
  return 3 + 1.8 * Math.log2(1 + citations);
}

/**
 * Obsidian-style force-directed citation graph: a continuous d3-force
 * simulation on canvas. Existing nodes keep their positions across
 * expansions (object identity in mergeGraph); dragging pins a node.
 */
const CitationGraph = forwardRef<CitationGraphHandle, CitationGraphProps>(function CitationGraph(
  { data, selectedId, savedGroupKeys, onNodeClick, onNodeDoubleClick, onBackgroundClick },
  ref,
) {
  const { resolved } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any>>(undefined);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const lastClickRef = useRef<{ id: string; time: number }>({ id: "", time: 0 });

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
  // range-limited) charge and short links spread expansions readably.
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
      // spaces big expansions readably.
      link.distance?.(90);
      link.strength?.(0.25);
    }
  }, []);

  // Resolve theme colors once per theme switch; the canvas re-draws every
  // frame so nodes/edges restyle instantly.
  const colors = useMemo<ThemeColors>(() => {
    void resolved;
    return {
      node: cssVar("--graph-node") || "#94a3b8",
      seed: cssVar("--graph-node-seed") || cssVar("--color-accent") || "#4f46e5",
      saved: cssVar("--graph-node-saved") || cssVar("--color-success") || "#059669",
      edge: cssVar("--graph-edge") || "#cbd5e1",
      label: cssVar("--color-text-secondary") || "#64748b",
      halo: cssVar("--color-accent") || "#4f46e5",
    };
  }, [resolved]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const fg = fgRef.current;
      if (fg) fg.zoom(fg.zoom() * 1.4, 250);
    },
    zoomOut: () => {
      const fg = fgRef.current;
      if (fg) fg.zoom(fg.zoom() / 1.4, 250);
    },
    fit: () => fgRef.current?.zoomToFit(400, 60),
    reheat: () => fgRef.current?.d3ReheatSimulation(),
  }));

  // Dev-only: expose live graph data for in-browser physics verification.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__openbibGraph = data;
      w.__openbibFg = fgRef.current;
    }
  }, [data]);

  const nodeColor = useCallback(
    (node: ForceNode): string => {
      if (node.node.is_seed) return colors.seed;
      if (savedGroupKeys?.has(node.id)) return colors.saved;
      return colors.node;
    },
    [colors, savedGroupKeys],
  );

  const drawNode = useCallback(
    (node: ForceNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = nodeRadius(node);

      // Selection halo
      if (node.id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3 / globalScale + 1.5, 0, 2 * Math.PI);
        ctx.strokeStyle = colors.halo;
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = nodeColor(node);
      ctx.fill();

      // Dashed ring marks multi-version groups.
      if (node.node.version_count > 1) {
        ctx.beginPath();
        ctx.setLineDash([2, 2]);
        ctx.arc(x, y, r + 1.5, 0, 2 * Math.PI);
        ctx.strokeStyle = nodeColor(node);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Titles fade in as the user zooms.
      if (globalScale > 1.3) {
        const title = node.node.selected_version.title || node.id;
        const label = title.length > 40 ? `${title.slice(0, 40)}…` : title;
        ctx.font = `${Math.max(10 / globalScale, 2.6)}px Inter, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = colors.label;
        ctx.fillText(label, x, y + r + 2);
      }
    },
    [colors, nodeColor, selectedId],
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

  return (
    <div ref={containerRef} className="graph-canvas-container" data-testid="citation-graph">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        nodeId="id"
        nodeVal={(node: ForceNode) => nodeRadius(node) ** 2 / 4}
        nodeLabel={(node: ForceNode) => node.node.selected_version.title || node.id}
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
        onNodeDragEnd={(node: ForceNode) => {
          // Dragging pins the node exactly where the user dropped it.
          node.fx = node.x;
          node.fy = node.y;
        }}
        enableNodeDrag
      />
    </div>
  );
});

export default CitationGraph;
export type { ForceGraphData, ForceLink, ForceNode };
