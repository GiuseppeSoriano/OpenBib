import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { PinToggle } from "@/components/graph/GraphNodePopup";
import { graphDotClass } from "@/components/graph/nodeStyle";
import { paperTitle } from "@/components/graph/paperText";
import type { GraphNode } from "@/types";

interface GraphPaperListProps {
  id?: string;
  className?: string;
  /** "drawer": the panel beside the canvas, with a visible header and Close. */
  variant?: "drawer" | "sheet";
  /** Papers on the canvas. */
  nodes: GraphNode[];
  pinOrder: string[];
  pinned: ReadonlySet<string>;
  /** paper_group_keys saved in the user's library (their centre mark). */
  saved?: ReadonlySet<string>;
  /** The selected paper's current range, in server order. */
  currentRangeIds: string[];
  /** Its bounds, shown after the section label ("Current range · 31–60"). */
  currentRange?: { start: number; end: number } | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  /** Drawer only: the header's Close button and Escape. */
  onClose?: () => void;
}

interface Section {
  key: string;
  label: string;
  /** Shown as "(n)" after the label; the range shows its bounds instead. */
  showCount: boolean;
  nodes: GraphNode[];
}

const EMPTY: ReadonlySet<string> = new Set();
const NAV_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/** Case- and accent-insensitive form for the title filter. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

/**
 * Every paper on the graph as a list: pinned papers, the current range in
 * server order, then the rest, with a title filter on top. The keyboard and
 * screen-reader equivalent of the canvas; a row selects its paper and
 * centers the view on it, and the arrow keys move between rows. The dot
 * repeats the node's colour (decorative: the row's state is in its
 * aria-current and the Pin toggle).
 */
export default function GraphPaperList({
  id,
  className = "",
  variant = "sheet",
  nodes,
  pinOrder,
  pinned,
  saved = EMPTY,
  currentRangeIds,
  currentRange = null,
  selectedId,
  onSelect,
  onTogglePin,
  onClose,
}: GraphPaperListProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const headingId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const needle = fold(query.trim());

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placed = new Set<string>();
  const take = (ids: string[]) =>
    ids.flatMap((nodeId) => {
      const node = byId.get(nodeId);
      if (!node || placed.has(nodeId)) return [];
      placed.add(nodeId);
      return needle && !fold(paperTitle(node.selected_version, t)).includes(needle) ? [] : [node];
    });

  const rangeLabel = currentRange
    ? `${t("graph.sectionCurrentRange")} · ${number.format(currentRange.start)}–${number.format(currentRange.end)}`
    : t("graph.sectionCurrentRange");
  const sections: Section[] = [
    { key: "pinned", label: t("graph.sectionPinned"), showCount: true, nodes: take(pinOrder.filter((nodeId) => pinned.has(nodeId))) },
    { key: "range", label: rangeLabel, showCount: !currentRange, nodes: take(currentRangeIds) },
    { key: "other", label: t("graph.sectionOther"), showCount: true, nodes: take(nodes.map((node) => node.id)) },
  ].filter((section) => section.nodes.length > 0);
  const matches = sections.reduce((sum, section) => sum + section.nodes.length, 0);

  // As on the canvas: the pin's fill, the Library's centre mark, and the
  // amber ring when selected.
  const dotClass = (nodeId: string) =>
    graphDotClass(pinned.has(nodeId), saved.has(nodeId), nodeId === selectedId);

  const meta = (node: GraphNode) => {
    const paper = node.selected_version;
    return [
      paper.publication_date?.slice(0, 4),
      typeof paper.cited_by_count === "number" ? t("common.citedBy", { count: paper.cited_by_count }) : null,
      // The dot's Library mark, in words.
      saved.has(node.id) ? t("graph.listInLibrary") : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  // A paper selected on the canvas (or anywhere else) is brought into view.
  useEffect(() => {
    if (!selectedId) return;
    const row = bodyRef.current?.querySelector<HTMLElement>('.graph-list-select[aria-current="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  // Up/Down (Home/End) move between rows, keeping the column: from a row
  // to the next row, from a Pin toggle to the next Pin toggle. Down from the
  // filter enters the list.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!NAV_KEYS.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".graph-list-row");
    if (!row || !bodyRef.current) return;
    const rows = Array.from(bodyRef.current.querySelectorAll<HTMLElement>(".graph-list-row"));
    const index = rows.indexOf(row);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else next = rows.length - 1;
    event.preventDefault();
    const selector = target.classList.contains("graph-pin-toggle") ? ".graph-pin-toggle" : ".graph-list-select";
    rows[next]?.querySelector<HTMLElement>(selector)?.focus();
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      bodyRef.current?.querySelector<HTMLElement>(".graph-list-select")?.focus();
    } else if (event.key === "Escape" && query) {
      // Escape clears the filter first; a second one closes the drawer.
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !onClose || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  const drawer = variant === "drawer";
  let status = "";
  if (nodes.length === 0) status = t("graph.papersEmpty");
  else if (needle && matches === 0) status = t("graph.filterNoMatch", { query: query.trim() });
  else if (needle) status = t("graph.filterMatches", { count: matches });
  const statusVisible = nodes.length === 0 || (!!needle && matches === 0);

  return (
    <aside
      id={id}
      className={`graph-paper-list graph-paper-list--${variant} ${className}`.trim()}
      aria-labelledby={headingId}
      onKeyDown={onPanelKeyDown}
    >
      <div className={drawer ? "graph-list-head" : "sr-only"}>
        <h2 id={headingId} className="graph-list-title">
          {t("graph.papersList")}
        </h2>
        {drawer && onClose && (
          <button
            type="button"
            className="graph-list-close"
            aria-label={t("graph.closePapers")}
            title={t("graph.closePapers")}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {nodes.length > 0 && (
        <div className="graph-list-filter">
          <Search size={14} className="graph-list-filter-icon" aria-hidden="true" />
          <input
            type="search"
            className="graph-list-filter-input"
            value={query}
            placeholder={t("graph.filterPlaceholder")}
            aria-label={t("graph.filterPapers")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFilterKeyDown}
          />
        </div>
      )}
      <p role="status" className={statusVisible ? "graph-list-empty" : "sr-only"}>
        {status}
      </p>
      <div ref={bodyRef} className="graph-list-body" onKeyDown={onListKeyDown}>
        {sections.map((section) => (
          <section key={section.key} className="graph-list-section" aria-labelledby={`${headingId}-${section.key}`}>
            <h3 id={`${headingId}-${section.key}`} className="graph-list-heading label-caps">
              {section.label}
              {section.showCount && (
                <span className="graph-list-count tabular"> ({number.format(section.nodes.length)})</span>
              )}
            </h3>
            <ul className="graph-list">
              {section.nodes.map((node) => {
                const title = paperTitle(node.selected_version, t);
                const line = meta(node);
                return (
                  <li key={node.id} className="graph-list-row">
                    <button
                      type="button"
                      className="graph-list-select"
                      aria-current={node.id === selectedId ? "true" : undefined}
                      onClick={() => onSelect(node.id)}
                    >
                      <span className={dotClass(node.id)} aria-hidden="true" />
                      <span className="graph-list-text">
                        {/* The full title as a tooltip on the clamped text, not on the
                            button: there it would be read again as its description. */}
                        <span className="graph-list-name" title={title}>
                          {title}
                        </span>
                        {line && <span className="graph-list-meta tabular">{line}</span>}
                      </span>
                    </button>
                    <PinToggle
                      pinned={pinned.has(node.id)}
                      title={title}
                      size={14}
                      className="graph-pin-toggle--quiet"
                      onToggle={() => onTogglePin(node.id)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
