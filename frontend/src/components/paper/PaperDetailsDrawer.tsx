import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, BookOpen, ExternalLink, GitFork, LogIn } from "lucide-react";
import { library, papers } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import Drawer from "@/components/ui/Drawer";
import Skeleton from "@/components/ui/Skeleton";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import TagEditor from "@/components/paper/TagEditor";
import NotesPanel from "@/components/paper/NotesPanel";
import { providerLabel } from "@/components/paper/PaperCard";
import "./PaperDetailsDrawer.css";

interface PaperDetailsDrawerProps {
  /** Canonical key of the paper to show; null keeps the drawer closed. */
  paperKey: string | null;
  onClose: () => void;
}

export default function PaperDetailsDrawer({ paperKey, onClose }: PaperDetailsDrawerProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: paper, isLoading, isError } = useQuery({
    queryKey: ["paper-detail", paperKey],
    queryFn: () => papers.getDetail(paperKey!),
    enabled: !!paperKey,
  });

  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!user && !!paperKey,
    staleTime: 30_000,
  });

  const inLibrary = !!paper && !!libraryKeys?.includes(paper.paper_group_key);

  const saveMutation = useMutation({
    mutationFn: () =>
      library.ensureEntry({
        paper_group_key: paper!.paper_group_key,
        paper_canonical_key: paper!.canonical_key,
        source_provider: paper!.provider_source,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
      toast(t("paper.savedToLibrary"), "success");
    },
  });

  const formatDate = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(new Date(value)) : null;

  return (
    <Drawer open={!!paperKey} onClose={onClose} title={t("paper.detailsTitle")}>
      {isLoading && <Skeleton lines={8} />}
      {isError && <p className="pd-error">{t("paper.notFound")}</p>}

      {paper && (
        <div className="pd" data-testid="paper-details">
          <h2 className="pd-title">{paper.title}</h2>

          <div className="pd-badges">
            {paper.open_access && <span className="badge">{t("paper.openAccess")}</span>}
            {paper.paper_type && <span className="badge badge--neutral">{paper.paper_type}</span>}
            {paper.version && <span className="badge badge-version">{paper.version}</span>}
            {(paper.provider_sources ?? []).map((source) => (
              <span key={source} className="badge badge--neutral">
                {providerLabel(source)}
              </span>
            ))}
          </div>

          {paper.authors.length > 0 && (
            <p className="pd-authors">{paper.authors.map((a) => a.name).join(", ")}</p>
          )}

          <p className="pd-venue">
            {[paper.venue, formatDate(paper.publication_date)].filter(Boolean).join(" · ")}
            {paper.volume && ` · Vol. ${paper.volume}`}
            {paper.issue && ` (${paper.issue})`}
            {paper.pages && `, ${paper.pages}`}
          </p>

          <div className="pd-counts">
            {paper.cited_by_count != null && (
              <span>{t("paper.citations", { count: paper.cited_by_count })}</span>
            )}
            {paper.reference_count != null && (
              <span>{t("paper.referencesCount", { count: paper.reference_count })}</span>
            )}
          </div>

          {paper.abstract && (
            <section className="pd-section">
              <h3>{t("paper.abstractHeading")}</h3>
              <p className="pd-abstract">{paper.abstract}</p>
            </section>
          )}

          <section className="pd-section">
            <h3>{t("paper.identifiers")}</h3>
            <ul className="pd-identifiers">
              {paper.doi && (
                <li>
                  <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={12} /> DOI: {paper.doi}
                  </a>
                </li>
              )}
              {paper.arxiv_id && (
                <li>
                  <a
                    href={`https://arxiv.org/abs/${paper.arxiv_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={12} /> arXiv: {paper.arxiv_id}
                  </a>
                </li>
              )}
              {paper.pmid && <li>PMID: {paper.pmid}</li>}
              {paper.pdf_url && (
                <li>
                  <a href={paper.pdf_url} target="_blank" rel="noopener noreferrer">
                    <BookOpen size={12} /> {t("paper.pdf")}
                  </a>
                </li>
              )}
            </ul>
          </section>

          {(paper.topics.length > 0 || paper.keywords.length > 0) && (
            <div className="pd-topics">
              {[...paper.topics, ...paper.keywords].slice(0, 10).map((topic) => (
                <span key={topic} className="badge">
                  {topic}
                </span>
              ))}
            </div>
          )}

          {paper.versions.length > 1 && (
            <section className="pd-section">
              <h3>{t("paper.versionsHeading")}</h3>
              <ul className="pd-versions">
                {paper.versions.map((version) => (
                  <li
                    key={version.canonical_key}
                    className={
                      version.canonical_key === paper.canonical_key ? "pd-version active" : "pd-version"
                    }
                  >
                    <span>
                      {version.version ||
                        version.publication_date?.slice(0, 4) ||
                        t("paper.undated")}
                    </span>
                    <span className="pd-version-provider">
                      {providerLabel(version.provider_source)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="pd-actions">
            <Link
              to={`/graph/${encodeURIComponent(paper.canonical_key)}`}
              className="btn btn-secondary"
              onClick={onClose}
            >
              <GitFork size={14} />
              {t("paper.exploreGraph")}
            </Link>
            {user && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => saveMutation.mutate()}
                disabled={inLibrary || saveMutation.isPending}
              >
                <BookMarked size={14} />
                {inLibrary ? t("paper.inLibrary") : t("paper.saveToLibrary")}
              </button>
            )}
          </div>

          {user ? (
            <>
              <section className="pd-section">
                <h3>{t("paper.readingState")}</h3>
                <ReadingStateSelect paperKey={paper.canonical_key} />
              </section>
              <section className="pd-section">
                <h3>{t("paper.tags")}</h3>
                <TagEditor paperKey={paper.canonical_key} />
              </section>
              <section className="pd-section">
                <h3>{t("paper.notes")}</h3>
                <NotesPanel paperKey={paper.canonical_key} paperGroupKey={paper.paper_group_key} />
              </section>
            </>
          ) : (
            <div className="pd-signin card">
              <p>{t("paper.signInToSave")}</p>
              <Link to="/login" className="btn btn-primary" onClick={onClose}>
                <LogIn size={14} />
                {t("nav.signIn")}
              </Link>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
