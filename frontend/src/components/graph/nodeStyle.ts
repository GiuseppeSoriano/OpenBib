import type { GraphNode } from "@/types";

/** Resolved theme colors (the canvas cannot read CSS custom properties). */
export interface NodeStyleColors {
  /** --graph-node */
  node: string;
  /** --graph-node-pinned */
  pinned: string;
  /** --graph-node-saved */
  saved: string;
  /** --graph-node-selected */
  selected: string;
  /** --color-bg: the gap between a node and its selection ring. */
  background: string;
  /** --color-surface: the inner stroke that marks a pin without relying on color. */
  surface: string;
}

export interface NodeStyleState {
  pinned: boolean;
  saved: boolean;
  selected: boolean;
}

export interface NodeStyle {
  fill: string;
  /** Outer ring over a background-colored gap ring, for the selected node. */
  selectedRing?: { color: string; gapColor: string };
  /** Thin inner stroke on pinned nodes. */
  innerStroke?: string;
  /** Dashed ring marking a multi-version group. */
  versionRing: boolean;
}

/**
 * Canvas style of one node. Fill precedence is pinned, then saved, then
 * default; `is_seed` no longer drives color (seeds start pinned instead).
 * Selection is a separate ring so it reads on pinned and unpinned nodes alike.
 */
export function nodeStyle(node: GraphNode, state: NodeStyleState, colors: NodeStyleColors): NodeStyle {
  const style: NodeStyle = {
    fill: state.pinned ? colors.pinned : state.saved ? colors.saved : colors.node,
    versionRing: node.version_count > 1,
  };
  if (state.selected) style.selectedRing = { color: colors.selected, gapColor: colors.background };
  if (state.pinned) style.innerStroke = colors.surface;
  return style;
}
