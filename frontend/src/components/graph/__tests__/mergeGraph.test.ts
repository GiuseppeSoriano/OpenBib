import { describe, it, expect } from "vitest";
import { EMPTY_GRAPH, mergeGraph, type ForceGraphData } from "@/components/graph/mergeGraph";
import type { GraphEdge, GraphNode, PaperMetadata } from "@/types";

function paper(key: string, title: string): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: `group:${key}`,
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
    cited_by_count: 10,
    reference_count: null,
    version: null,
    provider_source: "openalex",
    provider_sources: ["openalex"],
  };
}

function node(id: string, title = id): GraphNode {
  const p = paper(id, title);
  return {
    id,
    label: title,
    type: "paper",
    paper_group_key: id,
    version_count: 1,
    selected_version: p,
    versions: [p],
    is_seed: false,
  };
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, relation_type: "cited_by" };
}

describe("mergeGraph", () => {
  it("dedupes nodes by id and preserves existing node object identity", () => {
    const first = mergeGraph(EMPTY_GRAPH, { nodes: [node("a"), node("b")], edges: [] });
    const existingA = first.nodes.find((n) => n.id === "a")!;
    existingA.x = 120; // simulate d3 having positioned it
    existingA.y = -40;

    const second = mergeGraph(first, { nodes: [node("a"), node("c")], edges: [] });

    expect(second.nodes).toHaveLength(3);
    const mergedA = second.nodes.find((n) => n.id === "a")!;
    expect(mergedA).toBe(existingA); // same object → position survives
    expect(mergedA.x).toBe(120);
    expect(mergedA.y).toBe(-40);
  });

  it("dedupes links by (source, target, relation)", () => {
    const first = mergeGraph(EMPTY_GRAPH, {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    });
    const second = mergeGraph(first, {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b"), edge("b", "a")],
    });

    expect(second.links).toHaveLength(2);
  });

  it("dedupes links even after d3 replaced endpoints with node objects", () => {
    const first = mergeGraph(EMPTY_GRAPH, {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    });
    // Simulate react-force-graph mutating endpoints to node references.
    const link = first.links[0]!;
    link.source = first.nodes.find((n) => n.id === "a")!;
    link.target = first.nodes.find((n) => n.id === "b")!;

    const second = mergeGraph(first, {
      nodes: [],
      edges: [edge("a", "b")],
    });

    expect(second.links).toHaveLength(1);
  });

  it("spawns new nodes on a ring (50–80px) around their positioned edge partner", () => {
    const first = mergeGraph(EMPTY_GRAPH, { nodes: [node("hub")], edges: [] });
    const hub = first.nodes[0]!;
    hub.x = 500;
    hub.y = 300;

    const second = mergeGraph(
      first,
      { nodes: [node("leaf")], edges: [edge("leaf", "hub")] },
      "hub",
    );

    const leaf = second.nodes.find((n) => n.id === "leaf")!;
    const distance = Math.hypot((leaf.x ?? 0) - 500, (leaf.y ?? 0) - 300);
    expect(distance).toBeGreaterThanOrEqual(50);
    expect(distance).toBeLessThanOrEqual(80);
  });

  it("distributes multiple children angularly — no two land in the same spot", () => {
    const first = mergeGraph(EMPTY_GRAPH, { nodes: [node("hub")], edges: [] });
    first.nodes[0]!.x = 0;
    first.nodes[0]!.y = 0;

    const children = ["a", "b", "c"];
    const second = mergeGraph(
      first,
      {
        nodes: children.map((id) => node(id)),
        edges: children.map((id) => edge(id, "hub")),
      },
      "hub",
    );

    const placed = children.map((id) => second.nodes.find((n) => n.id === id)!);
    for (const child of placed) {
      const distance = Math.hypot(child.x ?? 0, child.y ?? 0);
      expect(distance).toBeGreaterThanOrEqual(50);
      expect(distance).toBeLessThanOrEqual(80);
    }
    // Ring distribution: pairwise separation is far larger than a heap.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const gap = Math.hypot(
          (placed[i]!.x ?? 0) - (placed[j]!.x ?? 0),
          (placed[i]!.y ?? 0) - (placed[j]!.y ?? 0),
        );
        expect(gap).toBeGreaterThan(40);
      }
    }
  });

  it("falls back to the anchor position for isolated new nodes", () => {
    const first = mergeGraph(EMPTY_GRAPH, { nodes: [node("anchor")], edges: [] });
    first.nodes[0]!.x = -200;
    first.nodes[0]!.y = 80;

    const second = mergeGraph(first, { nodes: [node("floating")], edges: [] }, "anchor");

    const floating = second.nodes.find((n) => n.id === "floating")!;
    const distance = Math.hypot((floating.x ?? 0) + 200, (floating.y ?? 0) - 80);
    expect(distance).toBeGreaterThanOrEqual(50);
    expect(distance).toBeLessThanOrEqual(80);
  });

  it("returns new array references so React detects the update", () => {
    const first: ForceGraphData = mergeGraph(EMPTY_GRAPH, { nodes: [node("a")], edges: [] });
    const second = mergeGraph(first, { nodes: [], edges: [] });
    expect(second).not.toBe(first);
    expect(second.nodes).not.toBe(first.nodes);
    expect(second.nodes[0]).toBe(first.nodes[0]);
  });
});
