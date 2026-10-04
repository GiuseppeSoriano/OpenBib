import { describe, it, expect } from "vitest";
import { graphDotClass, nodeStyle, type NodeStyleColors } from "@/components/graph/nodeStyle";
import type { GraphNode, PaperMetadata } from "@/types";

const colors: NodeStyleColors = {
  node: "grey",
  pinned: "teal",
  saved: "blue",
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

describe("nodeStyle", () => {
  it("fills pinned, then saved, then default", () => {
    expect(nodeStyle(graphNode(), { pinned: true, saved: true, selected: false }, colors).fill).toBe("teal");
    expect(nodeStyle(graphNode(), { pinned: false, saved: true, selected: false }, colors).fill).toBe("blue");
    expect(nodeStyle(graphNode(), { pinned: false, saved: false, selected: false }, colors).fill).toBe("grey");
  });

  it("no longer colors seeds once they are unpinned", () => {
    const style = nodeStyle(graphNode(1, true), { pinned: false, saved: false, selected: false }, colors);
    expect(style.fill).toBe("grey");
  });

  it("rings the selected node over a gap and keeps its own fill", () => {
    const ring = { color: "amber", gapColor: "paper" };
    const pinned = nodeStyle(graphNode(), { pinned: true, saved: false, selected: true }, colors);
    const saved = nodeStyle(graphNode(), { pinned: false, saved: true, selected: true }, colors);
    const plain = nodeStyle(graphNode(), { pinned: false, saved: false, selected: true }, colors);
    expect([pinned.fill, saved.fill, plain.fill]).toEqual(["teal", "blue", "grey"]);
    expect(pinned.selectedRing).toEqual(ring);
    expect(plain.selectedRing).toEqual(ring);
    expect(nodeStyle(graphNode(), { pinned: true, saved: false, selected: false }, colors).selectedRing).toBeUndefined();
  });

  it("draws a pin as a plain filled circle", () => {
    const style = nodeStyle(graphNode(), { pinned: true, saved: false, selected: false }, colors);
    expect(style).toEqual({ fill: "teal", versionRing: false });
  });

  it("flags multi-version groups", () => {
    expect(nodeStyle(graphNode(2), { pinned: false, saved: false, selected: false }, colors).versionRing).toBe(true);
    expect(nodeStyle(graphNode(1), { pinned: false, saved: false, selected: false }, colors).versionRing).toBe(false);
  });

  it("mirrors the canvas style on HTML dots", () => {
    expect(graphDotClass(true, true, false)).toBe("graph-dot graph-dot--pinned");
    expect(graphDotClass(false, true, true)).toBe("graph-dot graph-dot--saved graph-dot--selected");
    expect(graphDotClass(false, false, false)).toBe("graph-dot");
  });
});
