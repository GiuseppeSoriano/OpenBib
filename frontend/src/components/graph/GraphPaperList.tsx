import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PinToggle } from "@/components/graph/GraphNodePopup";
import { graphDotClass } from "@/components/graph/nodeStyle";
import { paperTitle } from "@/components/graph/paperText";
import type { GraphNode } from "@/types";

interface GraphPaperListProps {
  id?: string;
  className?: string;
  /** Papers on the canvas. */
  nodes: GraphNode[];
  pinOrder: string[];
  pinned: ReadonlySet<string>;
  /** paper_group_keys saved in the user's library (the node colour). */
  saved?: ReadonlySet<string>;
  /** The selected paper's current range, in server order. */
  currentRangeIds: string[];
  /** Its bounds, shown after the section label ("Current range · 31–60"). */
  currentRange?: { start: number; end: number } | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
}

interface Section {
  key: string;
  label: string;
  nodes: GraphNode[];
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Every paper on the graph as a list: pinned papers, the current range in
 * server order, then the rest. The keyboard and screen-reader equivalent
 * of the canvas; a row selects its paper and centers the view on it. The
 * dot repeats the node's colour (decorative: the row's state is in its
 * aria-current and the Pin toggle).
 */
export default function GraphPaperList({
  id,
  className = "",
  nodes,
  pinOrder,
  pinned,
  saved = EMPTY,
  currentRangeIds,
  currentRange = null,
  selectedId,
  onSelect,
  onTogglePin,
}: GraphPaperListProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const headingId = useId();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placed = new Set<string>();
  const take = (ids: string[]) =>
    ids.flatMap((nodeId) => {
      const node = byId.get(nodeId);
      if (!node || placed.has(nodeId)) return [];
      placed.add(nodeId);
      return [node];
    });

  const rangeLabel = currentRange
    ? `${t("graph.sectionCurrentRange")} · ${number.format(currentRange.start)}–${number.format(currentRange.end)}`
    : t("graph.sectionCurrentRange");
  const pinnedNodes = take(pinOrder.filter((nodeId) => pinned.has(nodeId)));
  const rangeNodes = take(currentRangeIds);
  const otherNodes = take(nodes.map((node) => node.id));
  const sections: Section[] = [
    { key: "pinned", label: t("graph.sectionPinned"), nodes: pinnedNodes },
    { key: "range", label: rangeLabel, nodes: rangeNodes },
    { key: "other", label: t("graph.sectionOther"), nodes: otherNodes },
  ];

  // As on the canvas: the state colour, plus the amber ring when selected.
  const dotClass = (nodeId: string) =>
    graphDotClass(pinned.has(nodeId), saved.has(nodeId), nodeId === selectedId);

  return (
    <aside id={id} className={`graph-paper-list ${className}`.trim()} aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        {t("graph.papersList")}
      </h2>
      {sections
        .filter((section) => section.nodes.length > 0)
        .map((section) => (
          <section key={section.key} className="graph-list-section" aria-labelledby={`${headingId}-${section.key}`}>
            <h3 id={`${headingId}-${section.key}`} className="graph-list-heading label-caps">
              {section.label} <span className="graph-list-count tabular">({number.format(section.nodes.length)})</span>
            </h3>
            <ul className="graph-list">
              {section.nodes.map((node) => {
                const title = paperTitle(node.selected_version, t);
                return (
                  <li key={node.id} className="graph-list-row">
                    <button
                      type="button"
                      className="graph-list-select"
                      aria-current={node.id === selectedId ? "true" : undefined}
                      onClick={() => onSelect(node.id)}
                    >
                      <span className={dotClass(node.id)} aria-hidden="true" />
                      <span className="graph-list-name">{title}</span>
                    </button>
                    <PinToggle
                      pinned={pinned.has(node.id)}
                      title={title}
                      className="graph-pin-toggle--quiet"
                      onToggle={() => onTogglePin(node.id)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </aside>
  );
}
