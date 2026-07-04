import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ExternalLink } from "lucide-react";
import type { PaperMetadata } from "@/types";
import "./PaperCard.css";

const PROVIDER_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  europepmc: "Europe PMC",
};

export function providerLabel(name: string | null | undefined): string {
  if (!name) return "—";
  return PROVIDER_LABELS[name] ?? name;
}

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
 * Shared presentation card for a paper — used by Search, Collections,
 * and Library. Context-specific behavior comes in through the
 * `headerBadges` and `actions` slots.
 */
export default function PaperCard({
  paper,
  onOpenDetails,
  headerBadges,
  providerSources,
  showAbstract = true,
  showTopics = true,
  actions,
  className = "",
}: PaperCardProps) {
  const { t } = useTranslation();
  const sources = providerSources ?? paper.provider_sources ?? [];

  return (
    <div className={`card paper-card ${className}`.trim()}>
      {sources.length > 0 && (
        <div className="provider-badges">
          {sources.map((source) => (
            <span key={source} className="badge badge-provider">
              {providerLabel(source)}
            </span>
          ))}
        </div>
      )}

      <div className="paper-card-top">
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
          {paper.version && <span className="badge badge-version">{paper.version}</span>}
        </div>
        <div className="paper-links">
          {paper.doi && (
            <a
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              title={t("paper.doi")}
            >
              <ExternalLink size={14} />
            </a>
          )}
          {paper.pdf_url && (
            <a
              href={paper.pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              title={t("paper.pdf")}
            >
              <BookOpen size={14} />
            </a>
          )}
        </div>
      </div>

      {paper.authors.length > 0 && (
        <p className="paper-authors">{paper.authors.map((author) => author.name).join(", ")}</p>
      )}

      <div className="paper-meta">
        {paper.venue && <span>{paper.venue}</span>}
        {paper.publication_date && <span>{paper.publication_date.slice(0, 4)}</span>}
        {paper.cited_by_count != null && (
          <span>{t("paper.citations", { count: paper.cited_by_count })}</span>
        )}
        {paper.open_access && <span className="badge">{t("paper.openAccess")}</span>}
      </div>

      {showAbstract && paper.abstract && (
        <p className="paper-abstract">
          {paper.abstract.length > 300 ? `${paper.abstract.slice(0, 300)}…` : paper.abstract}
        </p>
      )}

      {showTopics && paper.topics.length > 0 && (
        <div className="paper-topics">
          {paper.topics.slice(0, 5).map((topic) => (
            <span key={topic} className="badge">
              {topic}
            </span>
          ))}
        </div>
      )}

      {actions && <div className="paper-actions">{actions}</div>}
    </div>
  );
}
