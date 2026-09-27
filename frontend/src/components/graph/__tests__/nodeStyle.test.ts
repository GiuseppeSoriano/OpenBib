import { describe, it, expect } from "vitest";
import { nodeStyle, type NodeStyleColors } from "@/components/graph/nodeStyle";
import type { GraphNode, PaperMetadata } from "@/types";

const colors: NodeStyleColors = {
  node: "grey",
  pinned: "teal",
  saved: "blue",
  selected: "amber",
  background: "paper",
  surface: "white",
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
    expect(style.innerStroke).toBeUndefined();
  });

  it("rings the selected node over a gap, pinned or not", () => {
    const ring = { color: "amber", gapColor: "paper" };
    const pinned = nodeStyle(graphNode(), { pinned: true, saved: false, selected: true }, colors);
    const unpinned = nodeStyle(graphNode(), { pinned: false, saved: false, selected: true }, colors);
    expect(pinned.selectedRing).toEqual(ring);
    expect(unpinned.selectedRing).toEqual(ring);
    expect(pinned.fill).not.toBe(unpinned.fill);
    expect(nodeStyle(graphNode(), { pinned: true, saved: false, selected: false }, colors).selectedRing).toBeUndefined();
  });

  it("marks pins with an inner stroke, not color alone", () => {
    expect(nodeStyle(graphNode(), { pinned: true, saved: false, selected: false }, colors).innerStroke).toBe("white");
    expect(nodeStyle(graphNode(), { pinned: false, saved: true, selected: false }, colors).innerStroke).toBeUndefined();
  });

  it("flags multi-version groups", () => {
    expect(nodeStyle(graphNode(2), { pinned: false, saved: false, selected: false }, colors).versionRing).toBe(true);
    expect(nodeStyle(graphNode(1), { pinned: false, saved: false, selected: false }, colors).versionRing).toBe(false);
  });
});
