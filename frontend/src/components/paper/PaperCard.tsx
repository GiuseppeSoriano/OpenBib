import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PaperMetadata } from "@/types";
import { providerLabel } from "@/components/paper/versionLabel";
import "./PaperCard.css";

export { providerLabel };

interface PaperCardProps {
  paper: PaperMetadata;
  /** Clicking the title opens the details view. */
  onOpenDetails?: () => void;
  /** Extra badges rendered next to the title (saved / in-library / …). */
  headerBadges?: ReactNode;
  providerSources?: string[];
  showAbstract?: boolean;
  showTopics?: boolean;
  /** Action buttons rendered at the bottom of the card. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The shared paper card: title, authors, one quiet meta line.
 * No raw identifiers — context-specific behavior comes in through
 * the headerBadges and actions slots.
 */
export default function PaperCard({
  paper,
  onOpenDetails,
  headerBadges,
  providerSources,
  showAbstract = true,
  showTopics = false,
  actions,
  className = "",
}: PaperCardProps) {
  const { t } = useTranslation();
  const sources = providerSources ?? paper.provider_sources ?? [];

  const meta: string[] = [];
  if (paper.venue) meta.push(paper.venue);
  if (paper.publication_date) meta.push(paper.publication_date.slice(0, 4));
  if (paper.cited_by_count != null) {
    meta.push(t("paper.citations", { count: paper.cited_by_count }));
  }

  return (
    <article className={`card paper-card ${className}`.trim()}>
      <div className="paper-title-row">
        {onOpenDetails ? (
          <button
            type="button"
            className="paper-title paper-title-btn"
            onClick={onOpenDetails}
            title={t("paper.viewDetails")}
          >
            {paper.title}
          </button>
        ) : (
          <h3 className="paper-title">{paper.title}</h3>
        )}
        {headerBadges}
        {paper.open_access && <span className="badge">{t("paper.openAccess")}</span>}
      </div>

      {paper.authors.length > 0 && (
        <p className="paper-authors">{paper.authors.map((author) => author.name).join(", ")}</p>
      )}

      <p className="paper-meta">
        {meta.join(" · ")}
        {sources.length > 0 && (
          <span className="paper-sources"> — {sources.map(providerLabel).join(", ")}</span>
        )}
      </p>

      {showAbstract && paper.abstract && (
        <p className="paper-abstract">{paper.abstract}</p>
      )}

      {showTopics && paper.topics.length > 0 && (
        <div className="paper-topics">
          {paper.topics.slice(0, 3).map((topic) => (
            <span key={topic} className="badge badge--neutral">
              {topic}
            </span>
          ))}
        </div>
      )}

      {actions && <div className="paper-actions">{actions}</div>}
    </article>
  );
}
