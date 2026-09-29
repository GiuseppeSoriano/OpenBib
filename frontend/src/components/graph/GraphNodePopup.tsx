import { useId } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Pin, PinOff } from "lucide-react";
import VersionPicker from "@/components/search/VersionPicker";
import { isUnresolved, paperDoi, paperTitle } from "@/components/graph/paperText";
import type { GraphNode, PaperMetadata } from "@/types";

interface PinToggleProps {
  pinned: boolean;
  title: string;
  onToggle: () => void;
  className?: string;
}

/**
 * Pin toggle with a constant accessible name ("Pin “T”"): only aria-pressed
 * and the icon change, so screen readers announce one state.
 */
export function PinToggle({ pinned, title, onToggle, className = "" }: PinToggleProps) {
  const { t } = useTranslation();
  const Icon = pinned ? PinOff : Pin;
  return (
    <button
      type="button"
      className={`graph-pin-toggle ${className}`.trim()}
      aria-pressed={pinned}
      aria-label={t("graph.pinPaper", { title })}
      onClick={onToggle}
    >
      <Icon size={16} aria-hidden="true" />
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
}

/** The selected paper: pin toggle, title, authors, meta, versions, details. */
export default function GraphNodePopup({
  node,
  pinned,
  variant = "card",
  onTogglePin,
  onSelectVersion,
  onViewDetails,
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
      className={`graph-popup graph-popup--${variant}${variant === "card" ? " card" : ""}`}
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
      {!unresolved && (
        <div className="graph-popup-actions">
          <button type="button" className="btn btn-secondary graph-btn" onClick={onViewDetails}>
            <FileText size={14} aria-hidden="true" />
            {t("paper.viewDetails")}
          </button>
        </div>
      )}
    </section>
  );
}
