import { useId } from "react";
import { useTranslation } from "react-i18next";
import { PinToggle } from "@/components/graph/GraphNodePopup";
import { paperTitle } from "@/components/graph/paperText";
import type { GraphNode } from "@/types";

interface GraphPaperListProps {
  id?: string;
  className?: string;
  /** Papers on the canvas. */
  nodes: GraphNode[];
  pinOrder: string[];
  pinned: ReadonlySet<string>;
  /** The selected paper's current range, in server order. */
  currentRangeIds: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
}

interface Section {
  key: string;
  label: string;
  nodes: GraphNode[];
}

/**
 * Every paper on the graph as a list: pinned papers, the current range in
 * server order, then the rest. The keyboard and screen-reader equivalent
 * of the canvas; a row selects its paper and centers the view on it.
 */
export default function GraphPaperList({
  id,
  className = "",
  nodes,
  pinOrder,
  pinned,
  currentRangeIds,
  selectedId,
  onSelect,
  onTogglePin,
}: GraphPaperListProps) {
  const { t } = useTranslation();
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

  const pinnedNodes = take(pinOrder.filter((nodeId) => pinned.has(nodeId)));
  const rangeNodes = take(currentRangeIds);
  const otherNodes = take(nodes.map((node) => node.id));
  const sections: Section[] = [
    { key: "pinned", label: t("graph.sectionPinned"), nodes: pinnedNodes },
    { key: "range", label: t("graph.sectionCurrentRange"), nodes: rangeNodes },
    { key: "other", label: t("graph.sectionOther"), nodes: otherNodes },
  ];

  return (
    <aside id={id} className={`graph-paper-list ${className}`.trim()} aria-labelledby={headingId}>
      <h2 id={headingId} className="graph-paper-list-title">
        {t("graph.papersList")}
      </h2>
      {sections
        .filter((section) => section.nodes.length > 0)
        .map((section) => (
          <section key={section.key} className="graph-list-section" aria-labelledby={`${headingId}-${section.key}`}>
            <h3 id={`${headingId}-${section.key}`} className="graph-list-heading">
              {section.label} <span className="graph-list-count">({section.nodes.length})</span>
            </h3>
            <ul className="graph-list">
              {section.nodes.map((node) => {
                const paper = node.selected_version;
                const title = paperTitle(paper, t);
                const meta = [paper.publication_date?.slice(0, 4), paper.venue].filter(Boolean).join(" · ");
                return (
                  <li key={node.id} className="graph-list-row">
                    <button
                      type="button"
                      className="graph-list-select"
                      aria-current={node.id === selectedId ? "true" : undefined}
                      onClick={() => onSelect(node.id)}
                    >
                      <span className="graph-list-name">{title}</span>
                      {meta && <span className="graph-list-meta">{meta}</span>}
                    </button>
                    <PinToggle pinned={pinned.has(node.id)} title={title} onToggle={() => onTogglePin(node.id)} />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </aside>
  );
}
