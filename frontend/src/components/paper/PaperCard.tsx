import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PaperMetadata } from "@/types";
import { abstractPreview } from "@/lib/abstract";
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
  /** A note under the meta line (e.g. a possible other version). */
  note?: ReactNode;
  /** Action buttons rendered at the bottom of the card. */
  actions?: ReactNode;
  /** Extra content rendered between metadata and actions (e.g. version picker). */
  children?: ReactNode;
  className?: string;
  /**
   * "card" (default): a boxed card. "row": a hairline-separated list row with
   * a serif title, italic venue and open access in the meta line (Search).
   */
  variant?: "card" | "row";
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
  note,
  actions,
  children,
  className = "",
  variant = "card",
}: PaperCardProps) {
  const { t } = useTranslation();
  const sources = providerSources ?? paper.provider_sources ?? [];

  const row = variant === "row";
  const year = paper.publication_date ? paper.publication_date.slice(0, 4) : null;
  const hasMeta = !!paper.venue || !!year;
  // Citation counts differ by provider, so the card says whose count it shows.
  const citationProvider = paper.provider_source ? providerLabel(paper.provider_source) : null;
  const citationsFrom = citationProvider
    ? t("paper.citationsFrom", { provider: citationProvider })
    : undefined;
  // The source list only adds information when it names more than the
  // provider already credited with the citation count.
  const credited = paper.cited_by_count != null ? paper.provider_source : null;
  const showSources = sources.length > 0 && !(credited && sources.every((source) => source === credited));
  const preview = showAbstract ? abstractPreview(paper.abstract) : "";

  return (
    <article className={`${row ? "paper-card paper-card--row" : "card paper-card"} ${className}`.trim()}>
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
        {!row && paper.open_access && <span className="badge">{t("paper.openAccess")}</span>}
      </div>

      {paper.authors.length > 0 && (
        <p className="paper-authors">{paper.authors.map((author) => author.name).join(", ")}</p>
      )}

      <p className="paper-meta">
        {row ? (
          <>
            {paper.venue && <span className="paper-venue">{paper.venue}</span>}
            {paper.venue && year && " · "}
            {year}
          </>
        ) : (
          [paper.venue, year].filter(Boolean).join(" · ")
        )}
        {paper.cited_by_count != null && (
          <span className="paper-citations" title={citationsFrom}>
            {hasMeta && " · "}
            {t("common.citedBy", { count: paper.cited_by_count })}
            {citationProvider && (
              <>
                {/* Rows: the status line above the list already names the provider. */}
                {!row && (
                  <span className="paper-citations-source" aria-hidden="true">
                    {` · ${citationProvider}`}
                  </span>
                )}
                <span className="sr-only">{`, ${citationsFrom}`}</span>
              </>
            )}
          </span>
        )}
        {row && paper.open_access && (
          <span className="paper-oa">
            {" · "}
            {t("paper.openAccess")}
          </span>
        )}
        {showSources && (
          <span className="paper-sources"> — {sources.map(providerLabel).join(", ")}</span>
        )}
      </p>

      {note}

      {preview && <p className="paper-abstract">{preview}</p>}

      {showTopics && paper.topics.length > 0 && (
        <div className="paper-topics">
          {paper.topics.slice(0, 3).map((topic) => (
            <span key={topic} className="badge badge--neutral">
              {topic}
            </span>
          ))}
        </div>
      )}

      {children}

      {actions && <div className="paper-actions">{actions}</div>}
    </article>
  );
}
