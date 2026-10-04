import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Pin } from "lucide-react";
import VersionPicker from "@/components/search/VersionPicker";
import { isUnresolved, paperDoi, paperTitle } from "@/components/graph/paperText";
import type { GraphNode, PaperMetadata } from "@/types";

interface PinToggleProps {
  pinned: boolean;
  title: string;
  onToggle: () => void;
  className?: string;
  /** Glyph size; the quiet row toggle uses a smaller pin. */
  size?: number;
}

/**
 * Pin toggle with a constant accessible name ("Pin “T”"): only aria-pressed
 * and the icon change, so screen readers announce one state. Pressed fills
 * the pin, and the quiet row variant sits on a solid accent disc, like the
 * pinned node's filled circle on the canvas.
 */
export function PinToggle({ pinned, title, onToggle, className = "", size = 16 }: PinToggleProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`graph-pin-toggle ${className}`.trim()}
      aria-pressed={pinned}
      aria-label={t("graph.pinPaper", { title })}
      onClick={onToggle}
    >
      <Pin size={size} fill={pinned ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  );
}

interface GraphNodePopupProps {
  node: GraphNode;
  pinned: boolean;
  variant?: "card" | "sheet";
  onTogglePin: () => void;
  onSelectVersion: (version: PaperMetadata) => void;
  onViewDetails: () => void;
  /** Loads the paper's first range of related papers (1–30). */
  onExplore?: () => void;
}

/**
 * The selected paper: title and pin toggle, authors, meta, versions, then
 * View details and Explore from here. On wide screens it floats over the
 * canvas's top-right corner; in the compact sheet it is a plain card.
 */
export default function GraphNodePopup({
  node,
  pinned,
  variant = "card",
  onTogglePin,
  onSelectVersion,
  onViewDetails,
  onExplore,
}: GraphNodePopupProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const paper = node.selected_version;
  const unresolved = isUnresolved(paper);
  const title = paperTitle(paper, t);
  const doi = paperDoi(paper);
  const meta = [
    paper.venue,
    paper.publication_date?.slice(0, 4),
    typeof paper.cited_by_count === "number" ? t("paper.citations", { count: paper.cited_by_count }) : null,
  ].filter(Boolean);

  return (
    <section
      className={`graph-popup graph-popup--${variant}`}
      aria-labelledby={titleId}
      data-testid="graph-node-popup"
    >
      <div className="graph-popup-head">
        <h2 id={titleId} className="graph-popup-title">
          {title}
        </h2>
        <PinToggle pinned={pinned} title={title} onToggle={onTogglePin} />
      </div>
      {unresolved ? (
        doi && <p className="graph-popup-meta">DOI {doi}</p>
      ) : (
        <>
          {paper.authors.length > 0 && (
            <p className="graph-popup-authors">{paper.authors.map((author) => author.name).join(", ")}</p>
          )}
          {meta.length > 0 && <p className="graph-popup-meta">{meta.join(" · ")}</p>}
        </>
      )}
      {node.versions.length > 1 && (
        <VersionPicker
          versions={node.versions}
          selectedKey={paper.canonical_key}
          onSelect={onSelectVersion}
        />
      )}
      {(!unresolved || onExplore) && (
        <div className="graph-popup-actions">
          {!unresolved && (
            <button type="button" className="btn btn-primary btn--sm" onClick={onViewDetails}>
              {t("paper.viewDetails")}
            </button>
          )}
          {onExplore && (
            <button type="button" className="btn btn-secondary btn--sm" onClick={onExplore}>
              {t("graph.exploreFromHere")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
