import { createRef } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CitationGraph, { type CitationGraphHandle } from "@/components/graph/CitationGraph";
import { truncateLabel } from "@/components/graph/paperText";
import type { ForceGraphData, ForceNode } from "@/components/graph/mergeGraph";
import { ThemeProvider } from "@/contexts/ThemeContext";
import type { GraphNode, PaperMetadata } from "@/types";

// The canvas engine cannot run in jsdom: the stub records the props and
// exposes the engine methods the handle calls.
const engine = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: {} as Record<string, any>,
  reheat: vi.fn(),
  centerAt: vi.fn(),
  zoom: vi.fn((k?: number) => (k === undefined ? 1 : undefined)),
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

  it("centers the view on a focused node", () => {
    const { ref } = setup();
    act(() => ref.current!.focusNode("a"));
    expect(engine.centerAt).toHaveBeenCalledWith(10, 20, 400);
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
      // Labels come after every node: the selection's first, in its amber.
      expect(labels).toEqual([]);
      engine.props.onRenderFramePost(ctx, 1);
      expect(labels).toEqual(["#7a4d11", "#1a1e1d"]);
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
    // Zoomed out: the selection and the pin only.
    engine.props.onRenderFramePost(ctx, 1);
    expect(labels).toEqual(["Title s", "Title p"]);

    // A hovered paper joins them at any zoom.
    labels.length = 0;
    act(() => engine.props.onNodeHover(data.nodes[2]));
    engine.props.onRenderFramePost(ctx, 1);
    expect(labels).toEqual(["Title s", "Title c", "Title p"]);
    act(() => engine.props.onNodeHover(null));

    // Zoomed in: the others too, most cited first; "a" would overlap "b".
    labels.length = 0;
    engine.props.onRenderFramePost(ctx, 2);
    expect(labels).toEqual(["Title s", "Title p", "Title b", "Title c"]);
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
    // The selection always; then only the pins whose labels find free room.
    expect(labels[0]).toBe("Title s");
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
