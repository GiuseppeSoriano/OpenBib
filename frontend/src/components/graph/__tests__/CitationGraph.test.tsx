import { createRef } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CitationGraph, { type CitationGraphHandle } from "@/components/graph/CitationGraph";
import { truncateLabel } from "@/components/graph/paperText";
import type { ForceGraphData, ForceLink, ForceNode } from "@/components/graph/mergeGraph";
import { ThemeProvider } from "@/contexts/ThemeContext";
import type { GraphNode, PaperMetadata } from "@/types";

// The canvas engine cannot run in jsdom: the stub records the props and
// exposes the engine methods the handle calls.
const engine = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: {} as Record<string, any>,
  reheat: vi.fn(),
  centerAt: vi.fn(),
  zoom: vi.fn((k?: number): number | undefined => (k === undefined ? 1 : undefined)),
  zoomToFit: vi.fn(),
}));

vi.mock("react-force-graph-2d", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    default: forwardRef(function GraphStub(props: Record<string, unknown>, ref) {
      engine.props = props;
      useImperativeHandle(ref, () => ({
        d3Force: () => undefined,
        d3ReheatSimulation: engine.reheat,
        centerAt: engine.centerAt,
        zoom: engine.zoom,
        zoomToFit: engine.zoomToFit,
      }));
      return <div data-testid="force-graph-stub" />;
    }),
  };
});

function paper(key: string, title: string): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: key,
    title,
    authors: [],
    abstract: null,
    publication_date: null,
    doi: null,
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    openalex_id: null,
    venue: null,
    volume: null,
    issue: null,
    pages: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    abstract_url: null,
    cited_by_count: 3,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
  };
}

function forceNode(id: string, x: number, y: number): ForceNode {
  const version = paper(id, `Title ${id}`);
  const node: GraphNode = {
    id,
    label: version.title,
    type: "paper",
    paper_group_key: id,
    version_count: 1,
    selected_version: version,
    versions: [version],
    is_seed: false,
  };
  return { id, node, x, y };
}

/** A resolved link, as the engine hands it to the painter. */
function forceLink(source: ForceNode, target: ForceNode): ForceLink {
  return { source, target, relation_type: "cites" };
}

type Point = [number, number];

/** A 2D context that records each stroked and filled path with its paint. */
function linkRecorder() {
  let path: Point[] = [];
  const strokes: { points: Point[]; color: string; width: number }[] = [];
  const fills: { points: Point[]; color: string }[] = [];
  const ctx = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push([x, y]),
    lineTo: (x: number, y: number) => path.push([x, y]),
    closePath: () => undefined,
    stroke: () => strokes.push({ points: path, color: ctx.strokeStyle, width: ctx.lineWidth }),
    fill: () => fills.push({ points: path, color: ctx.fillStyle }),
  };
  return { ctx, strokes, fills };
}

/** The canvas's size and the engine's transform, as a context reports them. */
interface CanvasView {
  canvas: { width: number; height: number };
  transform: { a: number; d: number; e: number; f: number };
}

/**
 * A 2D context that records each label line filled (with the place its
 * label was moved to and its colour) and each line stroked as a halo, in
 * paint order. Every line measures `width` px. Without a `view`, every
 * place counts as on the canvas.
 */
function labelRecorder(width = 200, view?: CanvasView) {
  const fills: { text: string; x: number; y: number; at: Point; color: string }[] = [];
  const halos: string[] = [];
  let at: Point = [0, 0];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: (x: number, y: number) => {
      at = [x, y];
    },
    strokeText: (text: string) => halos.push(text),
    fillText: (text: string, x: number, y: number) => fills.push({ text, x, y, at, color: ctx.fillStyle }),
    measureText: () => ({ width }),
    ...(view && { canvas: view.canvas, getTransform: () => view.transform }),
  };
  return { ctx, fills, halos };
}

/** jsdom has no PointerEvent: a mouse event carrying the pointer's kind. */
function pointer(type: string, pointerType: string) {
  return Object.assign(new MouseEvent(type, { bubbles: type !== "pointerleave" }), { pointerType });
}

/** A title too long for one label line (129 characters). */
const LONG_TITLE =
  "Attention is all you need: transformers for sequence transduction without recurrence or convolution in neural machine translation";
/** LONG_TITLE, broken at its spaces onto lines of at most 48 characters. */
const LONG_TITLE_LINES = [
  "Attention is all you need: transformers for",
  "sequence transduction without recurrence or",
  "convolution in neural machine translation",
];

function titled(node: ForceNode, title: string): ForceNode {
  node.node.selected_version.title = title;
  return node;
}

const distance = ([ax, ay]: Point, [bx, by]: Point) => Math.hypot(bx - ax, by - ay);
const midpoint = ([ax, ay]: Point, [bx, by]: Point): Point => [(ax + bx) / 2, (ay + by) / 2];

/** Radius of the test papers (3 citations), in graph units. */
const PAPER_RADIUS = 4 + 10 * (Math.log10(4) / 5);

/** Lets a requestAnimationFrame callback (focusNode measures on one) run. */
function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function setup(pinnedIds: ReadonlySet<string> = new Set(), onNodeDragPin = vi.fn()) {
  const data: ForceGraphData = { nodes: [forceNode("a", 10, 20), forceNode("b", -5, 7)], links: [] };
  const ref = createRef<CitationGraphHandle>();
  render(
    <ThemeProvider>
      <CitationGraph
        ref={ref}
        data={data}
        selectedId={null}
        pinnedIds={pinnedIds}
        ariaLabel="Citation graph with 2 papers"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
        onNodeDragPin={onNodeDragPin}
      />
    </ThemeProvider>,
  );
  return { data, ref, onNodeDragPin };
}

describe("CitationGraph", () => {
  beforeEach(() => {
    engine.reheat.mockClear();
    engine.centerAt.mockClear();
    engine.zoomToFit.mockClear();
    engine.zoom.mockClear();
  });

  it("exposes the canvas as one labelled image", () => {
    setup();
    expect(screen.getByRole("img", { name: "Citation graph with 2 papers" })).toBeInTheDocument();
  });

  it("pins a dragged node where it was dropped and reports it", () => {
    const { data, onNodeDragPin } = setup();
    const node = data.nodes[0]!;
    node.x = 42;
    node.y = -3;
    act(() => engine.props.onNodeDragEnd(node));
    expect(node.fx).toBe(42);
    expect(node.fy).toBe(-3);
    expect(onNodeDragPin).toHaveBeenCalledWith("a");
  });

  it("pins at the current coordinates and unpins by releasing them", () => {
    const { data, ref } = setup();
    const node = data.nodes[1]!;
    act(() => ref.current!.pinNode("b"));
    expect(node.fx).toBe(-5);
    expect(node.fy).toBe(7);

    act(() => ref.current!.unpinNode("b"));
    expect("fx" in node).toBe(false);
    expect("fy" in node).toBe(false);
    expect(engine.reheat).toHaveBeenCalledTimes(1);
  });

  it("freezes only still-pinned nodes, on the first engine stop only", () => {
    const { data } = setup(new Set(["a"]));
    const [a, b] = data.nodes as [ForceNode, ForceNode];
    act(() => engine.props.onEngineStop());
    expect([a.fx, a.fy]).toEqual([10, 20]);
    expect(b.fx).toBeUndefined();

    delete a.fx;
    delete a.fy;
    act(() => engine.props.onEngineStop());
    expect(a.fx).toBeUndefined();
  });

  it("centers the view on a focused node, raising a low zoom to a moderate 1.5 only", async () => {
    const { ref } = setup();
    await act(async () => {
      ref.current!.focusNode("a");
      await nextFrame();
    });
    expect(engine.centerAt).toHaveBeenCalledWith(10, 20, 400);
    expect(engine.zoom).toHaveBeenCalledWith(1.5, 400);
  });

  it("keeps a focused node clear of the selected-paper card and never zooms further in", async () => {
    const card = document.createElement("div");
    card.getBoundingClientRect = () => ({ left: 684, top: 16, right: 984, bottom: 336 }) as DOMRect;
    const ref = createRef<CitationGraphHandle>();
    const data: ForceGraphData = { nodes: [forceNode("a", 10, 20)], links: [] };
    render(
      <CitationGraph
        ref={ref}
        data={data}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
        getOverlays={() => [card]}
      />,
    );
    const container = screen.getByTestId("citation-graph");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 600 });
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 600 }) as DOMRect;
    engine.zoom.mockImplementation((k?: number) => (k === undefined ? 2.5 : undefined));
    try {
      await act(async () => {
        ref.current!.focusNode("a");
        await nextFrame();
      });
      // The free area is the 684px left of the card: its middle is 158px
      // left of the canvas's, so the view centre moves 158 / 2.5 right.
      expect(engine.centerAt).toHaveBeenCalledWith(10 + 158 / 2.5, 20, 400);
      expect(engine.zoom).not.toHaveBeenCalledWith(expect.any(Number), 400);
    } finally {
      engine.zoom.mockImplementation((k?: number) => (k === undefined ? 1 : undefined));
    }
  });

  it("holds the engine's opening zoom on a lone seed to the fit cap, once", () => {
    setup();
    const container = screen.getByTestId("citation-graph");
    // force-graph opens a single node at 4x.
    act(() => engine.props.onZoomEnd({ k: 4, x: 0, y: 0 }));
    expect(engine.zoom).toHaveBeenCalledWith(2);
    act(() => engine.props.onZoomEnd({ k: 2, x: 0, y: 0 }));
    expect(container.dataset.zoom).toBe("2.00");

    // Later views (a zoom button, a resize) are left alone.
    engine.zoom.mockClear();
    act(() => engine.props.onZoomEnd({ k: 3.2, x: 0, y: 0 }));
    expect(engine.zoom).not.toHaveBeenCalled();
    expect(container.dataset.zoom).toBe("3.20");
  });

  it("leaves the opening zoom alone once the user moved the view", () => {
    setup();
    fireEvent.wheel(screen.getByTestId("citation-graph"));
    act(() => engine.props.onZoomEnd({ k: 4, x: 0, y: 0 }));
    expect(engine.zoom).not.toHaveBeenCalled();
  });

  it("punches a canvas-coloured centre mark into papers in the Library, pinned or not", () => {
    const style = document.documentElement.style;
    style.setProperty("--graph-canvas", "#f8faf9");
    style.setProperty("--graph-node-mark", "#f8faf9");
    style.setProperty("--graph-node", "#858f8a");
    style.setProperty("--graph-node-pinned", "#33695f");
    try {
      const data: ForceGraphData = {
        nodes: [forceNode("both", 0, 0), forceNode("pin", 50, 0), forceNode("lib", 100, 0), forceNode("none", 150, 0)],
        links: [],
      };
      render(
        <CitationGraph
          data={data}
          selectedId={null}
          savedGroupKeys={new Set(["both", "lib"])}
          pinnedIds={new Set(["both", "pin"])}
          ariaLabel="Citation graph"
          onNodeClick={vi.fn()}
          onBackgroundClick={vi.fn()}
        />,
      );
      const paint = { fillStyle: "", strokeStyle: "", globalAlpha: 1 };
      const draws: { fill: string; r: number }[][] = [];
      let current: { fill: string; r: number }[] = [];
      let radius = 0;
      const ctx = Object.assign(paint, {
        beginPath: vi.fn(),
        arc: vi.fn((_x: number, _y: number, r: number) => (radius = r)),
        fill: vi.fn(() => current.push({ fill: paint.fillStyle, r: radius })),
        stroke: vi.fn(),
        setLineDash: vi.fn(),
      });
      for (const node of data.nodes) {
        current = [];
        engine.props.nodeCanvasObject(node, ctx, 1);
        draws.push(current);
      }
      const r = 4 + 10 * (Math.log10(4) / 5);
      expect(draws[0]!.map((d) => d.fill)).toEqual(["#33695f", "#f8faf9"]);
      expect(draws[0]![1]!.r).toBeCloseTo(r * 0.4);
      expect(draws[1]!.map((d) => d.fill)).toEqual(["#33695f"]);
      expect(draws[2]!.map((d) => d.fill)).toEqual(["#858f8a", "#f8faf9"]);
      expect(draws[3]!.map((d) => d.fill)).toEqual(["#858f8a"]);
    } finally {
      for (const name of ["--graph-canvas", "--graph-node-mark", "--graph-node", "--graph-node-pinned"]) {
        style.removeProperty(name);
      }
    }
  });

  it("draws each link itself: a line between the circles and one arrowhead halfway, the same on screen at every zoom", () => {
    const a = forceNode("a", 0, 0);
    const b = forceNode("b", 120, 160);
    render(
      <CitationGraph
        data={{ nodes: [a, b], links: [] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    // The engine draws neither its own arrows nor a visible line of its own.
    expect(engine.props.linkDirectionalArrowLength).toBeUndefined();
    expect(engine.props.linkDirectionalArrowRelPos).toBeUndefined();
    expect(engine.props.linkColor(forceLink(a, b))).toBe("rgba(0,0,0,0)");

    // "a" cites "b".
    const cites = forceLink(a, b);
    for (const scale of [0.5, 1, 3]) {
      const { ctx, strokes, fills } = linkRecorder();
      engine.props.linkCanvasObject(cites, ctx, scale);
      expect(strokes).toHaveLength(1);
      expect(fills).toHaveLength(1);

      // A 1px line, held 2px clear of both circles (screen px).
      const [start, end] = strokes[0]!.points as [Point, Point];
      expect(strokes[0]!.width * scale).toBeCloseTo(1);
      expect((distance([0, 0], start) - PAPER_RADIUS) * scale).toBeCloseTo(2);
      expect((distance(end, [120, 160]) - PAPER_RADIUS) * scale).toBeCloseTo(2);

      // One arrowhead, 7px long and 6px wide, centred on the line's
      // midpoint (its tip 3.5px past it), pointing at the cited paper.
      const [tip, left, right] = fills[0]!.points as [Point, Point, Point];
      const base = midpoint(left, right);
      const length = distance(base, tip);
      expect(length * scale).toBeCloseTo(7);
      expect(distance(left, right) * scale).toBeCloseTo(6);
      expect(midpoint(base, tip)[0]).toBeCloseTo(midpoint(start, end)[0]);
      expect(midpoint(base, tip)[1]).toBeCloseTo(midpoint(start, end)[1]);
      expect((tip[0] - base[0]) / length).toBeCloseTo(0.6);
      expect((tip[1] - base[1]) / length).toBeCloseTo(0.8);
    }

    // The other way round, the arrowhead points back at "a".
    const { ctx, fills } = linkRecorder();
    engine.props.linkCanvasObject(forceLink(b, a), ctx, 1);
    const [tip, left, right] = fills[0]!.points as [Point, Point, Point];
    const base = midpoint(left, right);
    expect(tip[0]).toBeLessThan(base[0]);
    expect(tip[1]).toBeLessThan(base[1]);
  });

  it("keeps only the line on a link too short on screen for its arrowhead, and draws nothing between touching papers", () => {
    const a = forceNode("a", 0, 0);
    const near = forceNode("near", 20, 0);
    const touching = forceNode("touching", 8, 0);
    render(
      <CitationGraph
        data={{ nodes: [a, near, touching], links: [] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    // About 6px between the circles at 1x: the line only.
    let paint = linkRecorder();
    engine.props.linkCanvasObject(forceLink(a, near), paint.ctx, 1);
    expect(paint.strokes).toHaveLength(1);
    expect(paint.fills).toHaveLength(0);

    // Zoomed in, the same link has room for it.
    paint = linkRecorder();
    engine.props.linkCanvasObject(forceLink(a, near), paint.ctx, 4);
    expect(paint.fills).toHaveLength(1);

    paint = linkRecorder();
    engine.props.linkCanvasObject(forceLink(a, touching), paint.ctx, 1);
    expect(paint.strokes).toHaveLength(0);
    expect(paint.fills).toHaveLength(0);

    // Endpoints the engine has not resolved yet are skipped, not drawn.
    paint = linkRecorder();
    engine.props.linkCanvasObject({ source: "a", target: "near", relation_type: "cites" }, paint.ctx, 1);
    expect(paint.strokes).toHaveLength(0);
  });

  it("shades the hovered or selected paper's links darker, on top, at the same width and arrow size, without re-heating", () => {
    const style = document.documentElement.style;
    style.setProperty("--graph-edge", "#bac2be");
    style.setProperty("--graph-edge-arrow", "#858f8b");
    style.setProperty("--graph-edge-active", "#4f5a56");
    try {
      // Three papers on an equilateral triangle: every link is as long.
      const a = forceNode("a", 0, 0);
      const b = forceNode("b", 200, 0);
      const c = forceNode("c", 100, 173.2);
      const ab = forceLink(a, b);
      const ca = forceLink(c, a);
      const bc = forceLink(b, c);
      const data: ForceGraphData = { nodes: [a, b, c], links: [ab, ca, bc] };
      const graph = (selectedId: string | null) => (
        <CitationGraph
          data={data}
          selectedId={selectedId}
          ariaLabel="Citation graph"
          onNodeClick={vi.fn()}
          onBackgroundClick={vi.fn()}
        />
      );
      const view = render(graph(null));
      const paintAll = () =>
        data.links.map((link) => {
          const { ctx, strokes, fills } = linkRecorder();
          engine.props.linkCanvasObject(link, ctx, 2);
          const [tip, left, right] = fills[0]!.points as [Point, Point, Point];
          return {
            mode: engine.props.linkCanvasObjectMode(link),
            line: strokes[0]!.color,
            arrow: fills[0]!.color,
            width: strokes[0]!.width,
            arrowSize: [distance(midpoint(left, right), tip), distance(left, right)],
          };
        });

      // Nothing focused: every link in the quiet shades, in the engine's
      // first pass.
      let links = paintAll();
      for (const link of links) {
        expect(link).toMatchObject({ mode: "replace", line: "#bac2be", arrow: "#858f8b" });
      }
      const { width, arrowSize } = links[0]!;

      // The selection's links ("a" cites "b", "c" cites "a") turn the
      // active shade, line and arrowhead alike, and are drawn after the
      // others so they sit on top. Width and arrow size never change.
      const painter = engine.props.linkCanvasObject;
      view.rerender(graph("a"));
      expect(engine.props.linkCanvasObject).not.toBe(painter);
      expect(engine.props.graphData).toBe(data);
      links = paintAll();
      expect(links.map((link) => link.mode)).toEqual(["after", "after", "replace"]);
      expect(links.map((link) => link.line)).toEqual(["#4f5a56", "#4f5a56", "#bac2be"]);
      expect(links.map((link) => link.arrow)).toEqual(["#4f5a56", "#4f5a56", "#858f8b"]);
      for (const link of links) {
        expect(link.width).toBe(width);
        expect(link.arrowSize[0]).toBeCloseTo(arrowSize[0]!);
        expect(link.arrowSize[1]).toBeCloseTo(arrowSize[1]!);
      }

      // A hovered paper takes the focus from the selection while hovered.
      act(() => engine.props.onNodeHover(c));
      links = paintAll();
      expect(links.map((link) => link.mode)).toEqual(["replace", "after", "after"]);
      expect(links.map((link) => link.line)).toEqual(["#bac2be", "#4f5a56", "#4f5a56"]);
      act(() => engine.props.onNodeHover(null));
      expect(paintAll().map((link) => link.mode)).toEqual(["after", "after", "replace"]);

      // Focus only repaints: the layout is never re-heated.
      expect(engine.reheat).not.toHaveBeenCalled();
    } finally {
      style.removeProperty("--graph-edge");
      style.removeProperty("--graph-edge-arrow");
      style.removeProperty("--graph-edge-active");
    }
  });

  it("leaves links out of pointer picking: no link hover, tooltip or click", () => {
    setup();
    const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn() };
    engine.props.linkPointerAreaPaint(forceLink(forceNode("a", 0, 0), forceNode("b", 100, 0)), "#000001", ctx, 1);
    for (const draw of Object.values(ctx)) expect(draw).not.toHaveBeenCalled();
    expect(engine.props.onLinkHover).toBeUndefined();
    expect(engine.props.onLinkClick).toBeUndefined();
    expect(engine.props.linkLabel).toBeUndefined();
  });

  it("shows no engine tooltip on a hovered paper: its canvas label carries the title", () => {
    const { data } = setup();
    titled(data.nodes[0]!, LONG_TITLE);
    act(() => engine.props.onNodeHover(data.nodes[0]));
    // An empty label is no tooltip (left unset, the engine reads a `name`).
    for (const node of data.nodes) expect(engine.props.nodeLabel(node)).toBe("");
  });

  it("records the rounded view on the container after a zoom", () => {
    setup();
    act(() => engine.props.onZoomEnd({ k: 1.23456, x: 10.6, y: -4.2 }));
    const container = screen.getByTestId("citation-graph");
    expect(container.dataset.zoom).toBe("1.23");
    expect(container.dataset.cx).toBe("11");
    expect(container.dataset.cy).toBe("-4");
  });

  it("truncates long canvas labels to about 48 characters", () => {
    const long = "A".repeat(300);
    const label = truncateLabel(long);
    expect(label.length).toBe(48);
    expect(label.endsWith("…")).toBe(true);
    expect(truncateLabel("Short title")).toBe("Short title");

    const { data } = setup();
    const node = data.nodes[0]!;
    node.node = { ...node.node, selected_version: { ...node.node.selected_version, title: long } };
    const ctx = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 40 })),
    };
    engine.props.onRenderFramePost(ctx, 2);
    expect(ctx.fillText).toHaveBeenCalledWith(label, expect.any(Number), expect.any(Number));
  });

  it("labels a node still without details with a placeholder, never its key, on the canvas and on hover", () => {
    const { data } = setup();
    const [pending, given] = data.nodes as [ForceNode, ForceNode];
    const listData = (item: ForceNode, mark: object) => {
      const key = `doi:10.1049/iet-qtc.2020.000${item.id}`;
      const version = { ...item.node.selected_version, canonical_key: key, title: key };
      item.node = { ...item.node, selected_version: version, versions: [version], details_pending: true, ...mark };
    };
    listData(pending, {});
    listData(given, { detailsUnavailable: true });
    const labels: string[] = [];
    const ctx = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((label: string) => labels.push(label)),
      measureText: vi.fn(() => ({ width: 40 })),
    };
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toContain("Loading title…");
    // Once no refresh will bring it, the label says so.
    listData(pending, { detailsUnavailable: true });
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toContain("Title unavailable");
    expect(labels.some((label) => label.includes("doi:"))).toBe(false);
    // Hovered, a placeholder stays as it is, on its one line.
    listData(pending, { detailsUnavailable: false });
    for (const [node, placeholder] of [
      [pending, "Loading title…"],
      [given, "Title unavailable"],
    ] as const) {
      act(() => engine.props.onNodeHover(node));
      labels.length = 0;
      engine.props.onRenderFramePost(ctx, 1);
      expect(labels).toEqual([placeholder]);
    }
  });

  it("repaints on a payload revision without handing the engine new data", () => {
    const data: ForceGraphData = { nodes: [forceNode("a", 10, 20)], links: [] };
    const graph = (payloadRevision: number) => (
      <ThemeProvider>
        <CitationGraph
          data={data}
          payloadRevision={payloadRevision}
          selectedId={null}
          ariaLabel="Citation graph"
          onNodeClick={vi.fn()}
          onBackgroundClick={vi.fn()}
        />
      </ThemeProvider>
    );
    const { rerender } = render(graph(0));
    const painter = engine.props.nodeCanvasObject;
    rerender(graph(0));
    expect(engine.props.nodeCanvasObject).toBe(painter);

    // A title arrived in place: the engine gets a new painter (a repaint),
    // never new graph data (which would re-heat the layout).
    data.nodes[0]!.node = { ...data.nodes[0]!.node, label: "Arrived", selected_version: paper("a", "Arrived") };
    rerender(graph(1));
    expect(engine.props.graphData).toBe(data);
    expect(engine.props.nodeCanvasObject).not.toBe(painter);
    const fillText = vi.fn();
    const ctx = { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), fillText, measureText: () => ({ width: 40 }) };
    engine.props.onRenderFramePost(ctx, 2);
    expect(fillText).toHaveBeenCalledWith("Arrived", 0, 0);
  });

  it("keeps the selected node's fill, rings it with a soft halo and labels it in the theme's amber", () => {
    const style = document.documentElement.style;
    style.setProperty("--graph-canvas", "#f8faf9");
    style.setProperty("--graph-node", "#a0a8a4");
    style.setProperty("--graph-node-selected", "#8f5b14");
    style.setProperty("--color-state-toread-text", "#7a4d11");
    style.setProperty("--color-text", "#1a1e1d");
    try {
      // Far apart: an always-labelled node whose label would overlap the
      // selection's is skipped like a pinned one.
      const data: ForceGraphData = { nodes: [forceNode("a", 0, 0), forceNode("b", 0, 300)], links: [] };
      render(
        <ThemeProvider>
          <CitationGraph
            data={data}
            selectedId="a"
            alwaysLabelIds={new Set(["a", "b"])}
            ariaLabel="Citation graph"
            onNodeClick={vi.fn()}
            onBackgroundClick={vi.fn()}
          />
        </ThemeProvider>,
      );
      // Record the paint state at each stroke and label.
      const strokes: { style: string; alpha: number }[] = [];
      const labels: string[] = [];
      const fills: string[] = [];
      const paint = { fillStyle: "", strokeStyle: "", globalAlpha: 1 };
      const ctx = Object.assign(paint, {
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(() => fills.push(paint.fillStyle)),
        setLineDash: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        strokeText: vi.fn(),
        stroke: vi.fn(() => strokes.push({ style: paint.strokeStyle, alpha: paint.globalAlpha })),
        fillText: vi.fn(() => labels.push(paint.fillStyle)),
        measureText: vi.fn(() => ({ width: 40 })),
      });
      engine.props.nodeCanvasObject(data.nodes[0], ctx, 1);
      expect(strokes[0]).toEqual({ style: "#8f5b14", alpha: 0.18 });
      expect(strokes[1]).toEqual({ style: "#8f5b14", alpha: 1 });
      // Then the canvas-coloured gap between the fill and the ring.
      expect(strokes[2]).toEqual({ style: "#f8faf9", alpha: 1 });
      engine.props.nodeCanvasObject(data.nodes[1], ctx, 1);
      // Labels come after every node: the selection's over the others, in
      // its amber.
      expect(labels).toEqual([]);
      engine.props.onRenderFramePost(ctx, 1);
      expect(labels).toEqual(["#1a1e1d", "#7a4d11"]);
      // The selected node keeps its own fill inside the ring, like the others.
      expect(fills).toEqual(["#a0a8a4", "#a0a8a4"]);
      expect(ctx.globalAlpha).toBe(1);
    } finally {
      style.removeProperty("--graph-canvas");
      style.removeProperty("--graph-node");
      style.removeProperty("--graph-node-selected");
      style.removeProperty("--color-state-toread-text");
      style.removeProperty("--color-text");
    }
  });

  it("re-reads the theme colors once the theme attribute changes", async () => {
    const root = document.documentElement;
    root.style.setProperty("--color-text", "#1a1e1d");
    try {
      const data: ForceGraphData = { nodes: [forceNode("a", 0, 0)], links: [] };
      render(
        <ThemeProvider>
          <CitationGraph
            data={data}
            selectedId={null}
            alwaysLabelIds={new Set(["a"])}
            ariaLabel="Citation graph"
            onNodeClick={vi.fn()}
            onBackgroundClick={vi.fn()}
          />
        </ThemeProvider>,
      );
      const labels: string[] = [];
      const paint = { fillStyle: "", strokeStyle: "", globalAlpha: 1 };
      const ctx = Object.assign(paint, {
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        setLineDash: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        strokeText: vi.fn(),
        fillText: vi.fn(() => labels.push(paint.fillStyle)),
        measureText: vi.fn(() => ({ width: 40 })),
      });
      engine.props.onRenderFramePost(ctx, 1);

      // ThemeProvider writes data-theme after its children render: the
      // tokens are only read once the attribute itself has changed.
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      await act(async () => {
        root.style.setProperty("--color-text", "#e9efec");
        root.dataset.theme = next;
      });
      engine.props.onRenderFramePost(ctx, 1);
      expect(labels).toEqual(["#1a1e1d", "#e9efec"]);
    } finally {
      root.style.removeProperty("--color-text");
    }
  });

  it("labels pinned, selected and hovered papers always, others only zoomed in and never overlapping", () => {
    const data: ForceGraphData = {
      nodes: [forceNode("a", 0, 0), forceNode("b", 2, 1), forceNode("c", 300, 0), forceNode("p", 0, 400), forceNode("s", 0, -400)],
      links: [],
    };
    data.nodes[1]!.node.selected_version.cited_by_count = 50;
    render(
      <ThemeProvider>
        <CitationGraph
          data={data}
          selectedId="s"
          pinnedIds={new Set(["p"])}
          ariaLabel="Citation graph"
          onNodeClick={vi.fn()}
          onBackgroundClick={vi.fn()}
        />
      </ThemeProvider>,
    );
    const labels: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((label: string) => labels.push(label)),
      measureText: vi.fn(() => ({ width: 60 })),
    };
    // Zoomed out: the pin and the selection only, the selection's painted
    // over the others.
    engine.props.onRenderFramePost(ctx, 1);
    expect(labels).toEqual(["Title p", "Title s"]);

    // A hovered paper joins them at any zoom, painted last, on top.
    labels.length = 0;
    act(() => engine.props.onNodeHover(data.nodes[2]));
    engine.props.onRenderFramePost(ctx, 1);
    expect(labels).toEqual(["Title p", "Title s", "Title c"]);
    act(() => engine.props.onNodeHover(null));

    // Zoomed in: the others too, most cited first; "a" would overlap "b".
    labels.length = 0;
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toEqual(["Title p", "Title b", "Title c", "Title s"]);

    // Hovered, "a" shows its label after all, and the one of "b" gives way
    // to it until the pointer moves on.
    labels.length = 0;
    act(() => engine.props.onNodeHover(data.nodes[0]));
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toEqual(["Title p", "Title c", "Title s", "Title a"]);
    labels.length = 0;
    act(() => engine.props.onNodeHover(null));
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toEqual(["Title p", "Title b", "Title c", "Title s"]);
  });

  it("spells a hovered paper's cut title out on up to three lines, on top, and leaves a title that fits as it is", () => {
    const scaling = Array.from({ length: 6 }, () => "Scaling laws for neural language models").join(" ");
    const long = titled(forceNode("long", 0, 0), LONG_TITLE);
    const short = forceNode("short", 0, 200);
    const huge = titled(forceNode("huge", 0, -200), scaling);
    render(
      <CitationGraph
        data={{ nodes: [long, short, huge], links: [] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder();
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder;
    };

    // Not hovered: one line each, cut at about 48 characters.
    const before = frame().fills;
    expect(before.map((line) => line.text)).toEqual([truncateLabel(LONG_TITLE), "Title short", truncateLabel(scaling)]);

    // Hovered: the whole title, broken at its spaces, a line apart, over the
    // halo, where its one line was, and painted after the others.
    act(() => engine.props.onNodeHover(long));
    let { fills, halos } = frame();
    expect(fills.map((line) => line.text)).toEqual(["Title short", truncateLabel(scaling), ...LONG_TITLE_LINES]);
    const lines = fills.slice(2);
    expect(lines.map((line) => [line.x, line.y])).toEqual([
      [0, 0],
      [0, 15],
      [0, 30],
    ]);
    for (const line of lines) expect(line.at).toEqual(before[0]!.at);
    expect(halos).toEqual(LONG_TITLE_LINES);

    // Longer than three lines: the third ends in an ellipsis.
    act(() => engine.props.onNodeHover(huge));
    ({ fills } = frame());
    const hugeLines = fills.slice(2).map((line) => line.text);
    expect(hugeLines).toHaveLength(3);
    for (const line of hugeLines) expect(line.length).toBeLessThanOrEqual(48);
    expect(hugeLines.join(" ")).toMatch(/^Scaling laws for neural language models Scaling .*neural…$/);

    // A title that fits its line: nothing more appears, nothing moves.
    act(() => engine.props.onNodeHover(short));
    ({ fills, halos } = frame());
    expect(fills.filter((line) => line.text === "Title short")).toEqual([before[1]]);
    expect(fills).toHaveLength(3);
    expect(halos).toEqual(["Title short"]);
  });

  it("grows a hovered title from where its one line was, over a circle its other lines reach", () => {
    // At zoom 2 a label line is 7.5 units tall: the one line of "h" clears
    // the circle of "n" below it, three lines would reach into it.
    const h = titled(forceNode("h", 0, 0), LONG_TITLE);
    const n = forceNode("n", 0, 24);
    render(
      <CitationGraph
        data={{ nodes: [h, n], links: [] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder();
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills;
    };
    const before = frame();
    expect(before[0]!.text).toBe(truncateLabel(LONG_TITLE));
    expect(before[0]!.at).toEqual([0, PAPER_RADIUS + 1.5]);

    act(() => engine.props.onNodeHover(h));
    const lines = frame().filter((line) => line.at[0] === 0 && LONG_TITLE_LINES.includes(line.text));
    expect(lines.map((line) => line.text)).toEqual(LONG_TITLE_LINES);
    // All three below the paper, from where its one line was.
    for (const line of lines) expect(line.at).toEqual(before[0]!.at);
    expect(lines.map((line) => line.y)).toEqual([0, 15, 30]);
  });

  it("grows a hovered title up from above its paper where the canvas's edge would cut its lines below", () => {
    // Zoom 2 on a 400×100 canvas: graph y 50 is the bottom edge. One line
    // below "h" fits on it, three would not.
    const view: CanvasView = { canvas: { width: 400, height: 100 }, transform: { a: 2, d: 2, e: 200, f: 0 } };
    const h = titled(forceNode("h", -40, 30), LONG_TITLE);
    const short = forceNode("short", 60, 40);
    render(
      <CitationGraph
        data={{ nodes: [h, short], links: [] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder(200, view);
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills;
    };
    const below = 30 + PAPER_RADIUS + 1.5;
    const before = frame();
    expect(before.map((line) => [line.text, line.at])).toEqual([
      [truncateLabel(LONG_TITLE), [-40, below]],
      ["Title short", [60, 40 + PAPER_RADIUS + 1.5]],
    ]);

    act(() => engine.props.onNodeHover(h));
    const lines = frame().filter((line) => LONG_TITLE_LINES.includes(line.text));
    expect(lines.map((line) => line.text)).toEqual(LONG_TITLE_LINES);
    // Above the paper, its last line where a one-line label above would go.
    const [left, top] = lines[0]!.at;
    expect(left).toBe(-40);
    expect(top + 3 * 7.5).toBeCloseTo(30 - PAPER_RADIUS - 1.5);
    for (const line of lines) expect(line.at).toEqual([left, top]);

    // A title that fits its line stays where it is, though it runs past the
    // edge as well: hovering it adds nothing.
    act(() => engine.props.onNodeHover(short));
    expect(frame()).toEqual(before);
  });

  it("keeps the other labels clear of a hovered paper's spelled-out title until the pointer moves on", () => {
    // Hovered, the title of "h" runs to three lines below it: the label of
    // "o", to its right, and the selection's, to its left, would cross them.
    const h = titled(forceNode("h", 0, 0), LONG_TITLE);
    const o = forceNode("o", 70, 15);
    const s = forceNode("s", -70, 15);
    render(
      <CitationGraph
        data={{ nodes: [h, o, s], links: [] }}
        selectedId="s"
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder();
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills;
    };
    const before = frame();
    expect(before.map((line) => line.text)).toEqual([truncateLabel(LONG_TITLE), "Title o", "Title s"]);
    // The selection's label sits below its paper.
    expect(before[2]!.at[1]).toBeGreaterThan(15);

    act(() => engine.props.onNodeHover(h));
    const hovered = frame();
    // The label of "o" is left out; the selection's moves above its paper.
    expect(hovered.map((line) => line.text)).toEqual(["Title s", ...LONG_TITLE_LINES]);
    expect(hovered[0]!.at[0]).toBe(-70);
    expect(hovered[0]!.at[1]).toBeLessThan(15);

    act(() => engine.props.onNodeHover(null));
    expect(frame()).toEqual(before);
    // Hovering only repaints.
    expect(engine.reheat).not.toHaveBeenCalled();
  });

  it("spells the selected paper's cut title out on up to three lines without a hover, and keeps it through a hover elsewhere", () => {
    const style = document.documentElement.style;
    style.setProperty("--color-state-toread-text", "#7a4d11");
    style.setProperty("--color-text", "#1a1e1d");
    try {
      // Far apart, both with a title too long for one line: "s" is selected.
      const s = titled(forceNode("s", 0, 0), LONG_TITLE);
      const o = titled(forceNode("o", 0, 200), LONG_TITLE);
      render(
        <CitationGraph
          data={{ nodes: [s, o], links: [] }}
          selectedId="s"
          ariaLabel="Citation graph"
          onNodeClick={vi.fn()}
          onBackgroundClick={vi.fn()}
        />,
      );
      const frame = () => {
        const recorder = labelRecorder();
        engine.props.onRenderFramePost(recorder.ctx, 2);
        return recorder;
      };

      // Nothing hovered: the selection's title is spelled out whole, below
      // its paper (clear of its ring), a line apart, over its halo, in its
      // amber, and painted over the other label, which stays cut short.
      const idle = frame();
      expect(idle.fills.map((line) => line.text)).toEqual([truncateLabel(LONG_TITLE), ...LONG_TITLE_LINES]);
      expect(idle.fills[0]!.color).toBe("#1a1e1d");
      const lines = idle.fills.slice(1);
      expect(lines.map((line) => line.y)).toEqual([0, 15, 30]);
      for (const line of lines) {
        expect(line.at).toEqual([0, PAPER_RADIUS + 5]);
        expect(line.color).toBe("#7a4d11");
      }
      expect(idle.halos).toEqual(LONG_TITLE_LINES);

      // Hovering the other paper spells its title out as well, on top; the
      // selection's stays as it was.
      act(() => engine.props.onNodeHover(o));
      const hovered = frame().fills;
      expect(hovered.map((line) => line.text)).toEqual([...LONG_TITLE_LINES, ...LONG_TITLE_LINES]);
      expect(hovered.slice(0, 3)).toEqual(lines);
      for (const line of hovered.slice(3)) {
        expect(line.at).toEqual([0, 200 + PAPER_RADIUS + 1.5]);
        expect(line.color).toBe("#1a1e1d");
      }

      // Once the hover ends, the selection's title is still spelled out.
      act(() => engine.props.onNodeHover(null));
      const after = frame();
      expect(after.fills).toEqual(idle.fills);
      expect(after.halos).toEqual(idle.halos);

      // Hovering the selection itself changes nothing: its title is drawn
      // once, where it was, in its amber.
      act(() => engine.props.onNodeHover(s));
      const same = frame();
      expect(same.fills).toEqual(idle.fills);
      expect(same.halos).toEqual(idle.halos);
    } finally {
      style.removeProperty("--color-state-toread-text");
      style.removeProperty("--color-text");
    }
  });

  it("moves the selection's spelled-out title aside while a hovered label would cross its lower lines", () => {
    // At zoom 2 a label line is 7.5 units tall. Below "s", the first line
    // of the selection's title clears the label of "h"; its second and
    // third lines would cross it.
    const s = titled(forceNode("s", 0, 0), LONG_TITLE);
    const h = forceNode("h", 60, 14);
    render(
      <CitationGraph
        data={{ nodes: [s, h], links: [] }}
        selectedId="s"
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder();
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills;
    };
    const below = PAPER_RADIUS + 5;
    // Unhovered, the label of "h" gives way to the selection's lines.
    const before = frame();
    expect(before.map((line) => [line.text, line.at])).toEqual(LONG_TITLE_LINES.map((text) => [text, [0, below]]));

    // Hovered, "h" is labelled, and the selection's title moves above its
    // paper, whole, its last line where a one-line label above would go.
    act(() => engine.props.onNodeHover(h));
    const hovered = frame();
    expect(hovered.map((line) => line.text)).toEqual([...LONG_TITLE_LINES, "Title h"]);
    const [left, top] = hovered[0]!.at;
    expect(left).toBe(0);
    expect(top + 3 * 7.5).toBeCloseTo(-below);
    for (const line of hovered.slice(0, 3)) expect(line.at).toEqual([left, top]);

    // The hover over, it goes back below its paper.
    act(() => engine.props.onNodeHover(null));
    expect(frame()).toEqual(before);
  });

  it("keeps the selection's spelled-out title through a hover above it when no side is free of circles", () => {
    // At zoom 2, with lines 100 px wide (50 units), a label line is 7.5
    // units tall. Circles sit below, left and right of "s", so its title
    // only has room above it; "h", above that, labels itself right there.
    const s = titled(forceNode("s", 0, 0), LONG_TITLE);
    const h = forceNode("h", 0, -40);
    const nodes = [s, h, forceNode("b", 0, 14), forceNode("l", -60, 0), forceNode("r", 60, 0)];
    render(
      <CitationGraph
        data={{ nodes, links: [] }}
        selectedId="s"
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder(100);
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills;
    };
    const gap = PAPER_RADIUS + 5;

    // Unhovered, the title grows up from above "s", and the label of "h"
    // gives way to it.
    const before = frame();
    expect(before.map((line) => line.text)).toEqual(["Title b", "Title l", "Title r", ...LONG_TITLE_LINES]);
    for (const line of before.slice(3)) {
      expect(line.at[0]).toBe(0);
      expect(line.at[1]).toBeCloseTo(-gap - 3 * 7.5);
    }

    // Hovered, "h" is labelled below its paper, where the title above "s"
    // would go. The title moves to the first side clear of that label (the
    // right, across the circle of "r", whose label gives way) instead of
    // being left out.
    act(() => engine.props.onNodeHover(h));
    const hovered = frame();
    expect(hovered.map((line) => line.text)).toEqual(["Title b", "Title l", ...LONG_TITLE_LINES, "Title h"]);
    for (const line of hovered.slice(2, 5)) {
      expect(line.at[0]).toBeCloseTo(gap + 25);
      expect(line.at[1]).toBeCloseTo(-7.5 / 2);
    }
    expect(hovered[5]!.at[1]).toBeCloseTo(-40 + PAPER_RADIUS + 1.5);

    // The hover over, it is back above "s".
    act(() => engine.props.onNodeHover(null));
    expect(frame()).toEqual(before);
  });

  it("takes a touch for no hover: the touched paper's label and links stay as they are", () => {
    const a = titled(forceNode("a", 0, 0), LONG_TITLE);
    const b = forceNode("b", 200, 0);
    const link = forceLink(a, b);
    render(
      <CitationGraph
        data={{ nodes: [a, b], links: [link] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const texts = () => {
      const recorder = labelRecorder();
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills.map((line) => line.text);
    };
    const container = screen.getByTestId("citation-graph");

    // The engine reports the paper under a finger as hovered.
    fireEvent(container, pointer("pointerdown", "touch"));
    act(() => engine.props.onNodeHover(a));
    expect(texts()).toEqual([truncateLabel(LONG_TITLE), "Title b"]);
    expect(engine.props.linkCanvasObjectMode(link)).toBe("replace");

    // A mouse over it is a hover, though the engine, still on the same
    // paper, reports nothing new.
    fireEvent(container, pointer("pointermove", "mouse"));
    expect(texts()).toEqual(["Title b", ...LONG_TITLE_LINES]);
    expect(engine.props.linkCanvasObjectMode(link)).toBe("after");
  });

  it("ends the hover when the pointer leaves the canvas, though the engine still reports the paper", () => {
    // Hovered, the title of "h" runs to three lines, over the label of "o".
    const h = titled(forceNode("h", 0, 0), LONG_TITLE);
    const o = forceNode("o", 70, 15);
    const link = forceLink(h, o);
    render(
      <CitationGraph
        data={{ nodes: [h, o], links: [link] }}
        selectedId={null}
        ariaLabel="Citation graph"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    const frame = () => {
      const recorder = labelRecorder();
      engine.props.onRenderFramePost(recorder.ctx, 2);
      return recorder.fills;
    };
    const container = screen.getByTestId("citation-graph");
    const before = frame();
    expect(before.map((line) => line.text)).toEqual([truncateLabel(LONG_TITLE), "Title o"]);

    fireEvent(container, pointer("pointermove", "mouse"));
    act(() => engine.props.onNodeHover(h));
    expect(frame().map((line) => line.text)).toEqual(LONG_TITLE_LINES);
    expect(engine.props.linkCanvasObjectMode(link)).toBe("after");

    // Straight onto a card or the legend over the canvas, or off its edge:
    // the engine says nothing, the next frame is the unhovered one.
    engine.zoom.mockClear();
    fireEvent(container, pointer("pointerleave", "mouse"));
    expect(engine.zoom).toHaveBeenCalled();
    expect(frame()).toEqual(before);
    expect(engine.props.linkCanvasObjectMode(link)).toBe("replace");

    // Back over the canvas, the engine's paper is hovered again (until its
    // next frame finds another one under the pointer).
    fireEvent(container, pointer("pointermove", "mouse"));
    expect(frame().map((line) => line.text)).toEqual(LONG_TITLE_LINES);
  });

  it("keeps labels off neighbouring nodes: others are skipped, a pin's moves aside or is skipped", () => {
    // "n" sits just above "below": its title would cross that circle.
    const data: ForceGraphData = { nodes: [forceNode("n", 0, 0), forceNode("below", 0, 20)], links: [] };
    data.nodes[0]!.node.selected_version.cited_by_count = 50;
    const props = { data, selectedId: null, ariaLabel: "Citation graph", onNodeClick: vi.fn(), onBackgroundClick: vi.fn() };
    const view = render(<CitationGraph {...props} />);
    const labels: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((label: string) => labels.push(label)),
      measureText: vi.fn(() => ({ width: 60 })),
    };
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toEqual(["Title below"]);

    // Pinned, it is labelled anyway, over its halo, and above its paper,
    // clear of the circle below.
    labels.length = 0;
    ctx.translate.mockClear();
    view.rerender(<CitationGraph {...props} pinnedIds={new Set(["n"])} />);
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toEqual(["Title n", "Title below"]);
    expect(ctx.strokeText).toHaveBeenCalledWith("Title n", 0, 0);
    expect(ctx.translate.mock.calls[0]![1]).toBeLessThan(0);

    // With a paper above as well, it goes to the right of its paper.
    labels.length = 0;
    ctx.translate.mockClear();
    const walled: ForceGraphData = { nodes: [...data.nodes, forceNode("above", 0, -20)], links: [] };
    view.rerender(<CitationGraph {...props} data={walled} pinnedIds={new Set(["n"])} />);
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels[0]).toBe("Title n");
    expect(ctx.translate.mock.calls[0]![0]).toBeGreaterThan(0);

    // Hemmed in on every side, the pin's title is left out rather than
    // drawn across a circle...
    labels.length = 0;
    ctx.translate.mockClear();
    const boxed: ForceGraphData = {
      nodes: [...walled.nodes, forceNode("left", -40, 0), forceNode("right", 40, 0)],
      links: [],
    };
    view.rerender(<CitationGraph {...props} data={boxed} pinnedIds={new Set(["n"])} />);
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).not.toContain("Title n");

    // ...but the selection is always labelled, below it (painted over the
    // others' labels, last).
    labels.length = 0;
    ctx.translate.mockClear();
    view.rerender(<CitationGraph {...props} data={boxed} selectedId="n" />);
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels[labels.length - 1]).toBe("Title n");
    expect(labels.filter((label) => label === "Title n")).toHaveLength(1);
    const selection = ctx.translate.mock.calls[ctx.translate.mock.calls.length - 1]!;
    expect(selection[0]).toBe(0);
    expect(selection[1]).toBeGreaterThan(0);
  });

  it("moves a crossing selection label to a free side that stays on the canvas", () => {
    // Papers above and below "n", near the canvas's right edge: the right
    // side is free but runs off the canvas, so the title goes left.
    const data: ForceGraphData = {
      nodes: [forceNode("n", 100, 50), forceNode("up", 100, 30), forceNode("down", 100, 70)],
      links: [],
    };
    render(
      <CitationGraph data={data} selectedId="n" ariaLabel="Citation graph" onNodeClick={vi.fn()} onBackgroundClick={vi.fn()} />,
    );
    const labels: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      canvas: { width: 130, height: 200 },
      getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((label: string) => labels.push(label)),
      measureText: vi.fn(() => ({ width: 60 })),
    };
    engine.props.onRenderFramePost(ctx, 2);
    // The selection's label is painted last, over the others.
    expect(labels[labels.length - 1]).toBe("Title n");
    expect(ctx.translate.mock.calls[ctx.translate.mock.calls.length - 1]![0]).toBeLessThan(100);
  });

  it("skips pinned labels that would overlap one already drawn, so a fully pinned collection stays legible", () => {
    // A collection graph pins every paper: twelve pins crowded together.
    const nodes = Array.from({ length: 12 }, (_, i) => forceNode(`p${i}`, (i % 3) * 4, Math.floor(i / 3) * 4));
    nodes.push(forceNode("s", 6, 6), forceNode("far", 0, 500));
    nodes.forEach((node, i) => {
      node.node.selected_version.cited_by_count = 100 - i;
    });
    const data: ForceGraphData = { nodes, links: [] };
    render(
      <ThemeProvider>
        <CitationGraph
          data={data}
          selectedId="s"
          pinnedIds={new Set(nodes.map((node) => node.id).filter((id) => id !== "s"))}
          ariaLabel="Citation graph"
          onNodeClick={vi.fn()}
          onBackgroundClick={vi.fn()}
        />
      </ThemeProvider>,
    );
    const labels: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((label: string) => labels.push(label)),
      measureText: vi.fn(() => ({ width: 60 })),
    };
    engine.props.onRenderFramePost(ctx, 1);
    // The selection always (painted last, over the pins); then only the pins
    // whose labels find free room.
    expect(labels[labels.length - 1]).toBe("Title s");
    expect(labels).toContain("Title far");
    expect(labels.length).toBeLessThan(5);
  });

  it("fits the view once after the first range adds papers, unless the user moved it", () => {
    vi.useFakeTimers();
    try {
      const base: ForceGraphData = { nodes: [forceNode("a", 0, 0)], links: [] };
      const props = { selectedId: null, ariaLabel: "Citation graph", onNodeClick: vi.fn(), onBackgroundClick: vi.fn() };
      const view = render(<CitationGraph data={base} {...props} />);
      vi.advanceTimersByTime(2000);
      expect(engine.zoomToFit).not.toHaveBeenCalled();

      const range: ForceGraphData = { nodes: [...base.nodes, forceNode("b", 5, 5), forceNode("c", 9, 9)], links: [] };
      view.rerender(<CitationGraph data={range} {...props} />);
      expect(engine.zoomToFit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(engine.zoomToFit).toHaveBeenCalledTimes(1);

      // Only once: later ranges leave the view to the user.
      view.rerender(<CitationGraph data={{ nodes: [...range.nodes, forceNode("d", 1, 1)], links: [] }} {...props} />);
      vi.advanceTimersByTime(2000);
      expect(engine.zoomToFit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the automatic fit after the user zoomed with the wheel", () => {
    vi.useFakeTimers();
    try {
      const base: ForceGraphData = { nodes: [forceNode("a", 0, 0)], links: [] };
      const props = { selectedId: null, ariaLabel: "Citation graph", onNodeClick: vi.fn(), onBackgroundClick: vi.fn() };
      const view = render(<CitationGraph data={base} {...props} />);
      fireEvent.wheel(screen.getByTestId("citation-graph"));
      view.rerender(<CitationGraph data={{ nodes: [...base.nodes, forceNode("b", 5, 5)], links: [] }} {...props} />);
      vi.advanceTimersByTime(2000);
      expect(engine.zoomToFit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
