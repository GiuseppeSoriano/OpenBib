import { describe, it, expect } from "vitest";
import {
  graphDotClass,
  markRadius,
  nodeRadius,
  nodeStyle,
  type NodeStyleColors,
  type NodeStyleState,
} from "@/components/graph/nodeStyle";
import type { GraphNode, PaperMetadata } from "@/types";

const colors: NodeStyleColors = {
  node: "grey",
  pinned: "teal",
  mark: "paper",
  selected: "amber",
  background: "paper",
};

function graphNode(versionCount = 1, isSeed = false): GraphNode {
  const version = { canonical_key: "hash:a", title: "A" } as PaperMetadata;
  return {
    id: "a",
    label: "A",
    type: "paper",
    paper_group_key: "a",
    version_count: versionCount,
    selected_version: version,
    versions: [version],
    is_seed: isSeed,
  };
}

const ring = { color: "amber", gapColor: "paper" };

describe("nodeStyle", () => {
  // Every combination of pinned, in the Library and selected: two fills,
  // the Library as a centre mark, the selection as an outer ring only.
  it.each<[string, NodeStyleState, { fill: string; mark?: string; selectedRing?: typeof ring }]>([
    ["plain", { pinned: false, saved: false, selected: false }, { fill: "grey" }],
    ["pinned", { pinned: true, saved: false, selected: false }, { fill: "teal" }],
    ["in the Library", { pinned: false, saved: true, selected: false }, { fill: "grey", mark: "paper" }],
    ["pinned and in the Library", { pinned: true, saved: true, selected: false }, { fill: "teal", mark: "paper" }],
    ["selected", { pinned: false, saved: false, selected: true }, { fill: "grey", selectedRing: ring }],
    ["selected and pinned", { pinned: true, saved: false, selected: true }, { fill: "teal", selectedRing: ring }],
    ["selected, in the Library", { pinned: false, saved: true, selected: true }, { fill: "grey", mark: "paper", selectedRing: ring }],
    ["selected, pinned, in the Library", { pinned: true, saved: true, selected: true }, { fill: "teal", mark: "paper", selectedRing: ring }],
  ])("styles a %s node", (_name, state, expected) => {
    expect(nodeStyle(graphNode(), state, colors)).toEqual({ ...expected, versionRing: false });
  });

  it("never fills a node with a Library colour", () => {
    const fills = [true, false].flatMap((pinned) =>
      [true, false].map((selected) => nodeStyle(graphNode(), { pinned, saved: true, selected }, colors).fill),
    );
    expect(new Set(fills)).toEqual(new Set(["teal", "grey"]));
  });

  it("no longer colors seeds once they are unpinned", () => {
    const style = nodeStyle(graphNode(1, true), { pinned: false, saved: false, selected: false }, colors);
    expect(style.fill).toBe("grey");
  });

  it("flags multi-version groups", () => {
    expect(nodeStyle(graphNode(2), { pinned: false, saved: false, selected: false }, colors).versionRing).toBe(true);
    expect(nodeStyle(graphNode(1), { pinned: false, saved: false, selected: false }, colors).versionRing).toBe(false);
  });

  it("mirrors the canvas style on HTML dots, the Library mark included", () => {
    expect(graphDotClass(true, true, false)).toBe("graph-dot graph-dot--pinned graph-dot--saved");
    expect(graphDotClass(true, false, false)).toBe("graph-dot graph-dot--pinned");
    expect(graphDotClass(false, true, true)).toBe("graph-dot graph-dot--saved graph-dot--selected");
    expect(graphDotClass(false, false, false)).toBe("graph-dot");
  });

  it("sizes the Library mark with the node, never below 1.5 screen pixels nor above 60% of the node", () => {
    expect(markRadius(10, 1)).toBeCloseTo(4);
    expect(markRadius(14, 2)).toBeCloseTo(5.6);
    // Zoomed out, a small node keeps a visible mark: 1.5px on screen.
    expect(markRadius(4, 0.8) * 0.8).toBeCloseTo(1.5);
    expect(markRadius(8, 0.4) * 0.4).toBeCloseTo(1.5);
    // Very far out the fill still rings the mark.
    expect(markRadius(4, 0.1)).toBeCloseTo(2.4);
  });

  it("scales the radius by citations within 4–14 graph units", () => {
    expect(nodeRadius(null)).toBe(4);
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(99)).toBeCloseTo(8);
    expect(nodeRadius(9_999)).toBeCloseTo(12);
    expect(nodeRadius(99_999)).toBeCloseTo(14);
    expect(nodeRadius(5_000_000)).toBe(14);
    expect(nodeRadius(10)).toBeLessThan(nodeRadius(1_000));
  });
});
