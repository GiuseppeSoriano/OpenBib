import { createRef } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
        zoomToFit: vi.fn(),
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
      strokeText: vi.fn(),
      fillText: vi.fn(),
    };
    engine.props.nodeCanvasObject(node, ctx, 2);
    expect(ctx.fillText).toHaveBeenCalledWith(label, expect.any(Number), expect.any(Number));
  });
});
