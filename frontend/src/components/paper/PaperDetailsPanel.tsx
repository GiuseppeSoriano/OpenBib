import { useId, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, FileDown, GitFork, LogIn, Pin, Trash2 } from "lucide-react";
import api, { library, papers } from "@/lib/api";
import { abstractParagraphs } from "@/lib/abstract";
import { apiStatus } from "@/lib/apiError";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import Panel from "@/components/ui/Panel";
import Skeleton from "@/components/ui/Skeleton";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import TagEditor from "@/components/paper/TagEditor";
import NotesPanel from "@/components/paper/NotesPanel";
import AddToCollectionMenu from "@/components/paper/AddToCollectionMenu";
import ExternalLinkChip from "@/components/paper/ExternalLinkChip";
import { fullTextLinks } from "@/components/paper/links";
import {
  providerLabel,
  versionLabels,
  type VersionLabel,
} from "@/components/paper/versionLabel";
import type { LibraryVersionPin, PaperMemberships } from "@/types";
import "./PaperDetailsPanel.css";

interface PaperDetailsPanelProps {
  /** Canonical key of the paper to show; null keeps the panel closed. */
  paperKey: string | null;
  onClose: () => void;
  /** Focus target on close when the opener no longer exists. */
  fallbackFocus?: () => HTMLElement | null | undefined;
}

/** Human label for a pinned version — metadata match first, provider fallback. */
function pinLabel(pin: LibraryVersionPin, labels: Map<string, VersionLabel>): VersionLabel {
  const match = labels.get(pin.paper_canonical_key);
  if (match) return match;
  const label = providerLabel(pin.source_provider);
  return { label, accessibleName: label, details: "" };
}

/** A version row's text: the distinct label plus a quieter details line. */
function VersionText({ info, id }: { info: VersionLabel; id?: string }) {
  return (
    <span className="pd-version-text">
      <span className="pd-version-label" id={id}>
        {info.label}
      </span>
      {info.details && <span className="pd-version-details">{info.details}</span>}
    </span>
  );
}

/**
 * The paper detail view: rich human-readable metadata and actions.
 * Low-level identifiers (DOIs, canonical keys) never appear as text —
 * external references are presented as link chips.
 */
export default function PaperDetailsPanel({
  paperKey,
  onClose,
  fallbackFocus,
}: PaperDetailsPanelProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
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

  const { data: memberships } = useQuery({
    queryKey: ["paper-memberships"],
    queryFn: async () => {
      const { data } = await api.get<PaperMemberships>("/collections/paper-memberships");
      return data;
    },
    enabled: !!user && !!paperKey,
    staleTime: 30_000,
  });

  const inLibrary = !!paper && !!libraryKeys?.includes(paper.paper_group_key);

  // Library entry (managed version pins) — only for papers in the library.
  const entryQueryKey = ["library-entry", paper?.paper_group_key] as const;
  const { data: entry } = useQuery({
    queryKey: entryQueryKey,
    queryFn: () => library.getEntry(paper!.paper_group_key),
    enabled: !!user && inLibrary,
  });

  const invalidateEntry = () => {
    void queryClient.invalidateQueries({ queryKey: entryQueryKey });
    void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
    void queryClient.invalidateQueries({ queryKey: ["library-keys"] });
  };

  const repinMutation = useMutation({
    mutationFn: (canonicalKey: string) =>
      library.repinPrimary(paper!.paper_group_key, canonicalKey),
    onSuccess: invalidateEntry,
    onError: () => toast(t("library.repinFailed"), "error"),
  });

  const removeVersionMutation = useMutation({
    mutationFn: (canonicalKey: string) =>
      library.removeVersion(paper!.paper_group_key, canonicalKey),
    onSuccess: invalidateEntry,
    onError: (err: unknown) => {
      toast(apiStatus(err) === 409 ? t("library.remove409") : t("library.removeFailed"), "error");
    },
  });

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
    value
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(new Date(value))
      : null;

  const labels = useMemo(
    () => versionLabels(paper?.versions ?? [], t, i18n.language),
    [paper, t, i18n.language],
  );
  const paragraphs = useMemo(() => abstractParagraphs(paper?.abstract), [paper]);
  const fullText = useMemo(() => (paper ? fullTextLinks(paper) : []), [paper]);

  return (
    <Panel
      open={!!paperKey}
      onClose={onClose}
      title={t("paper.detailsTitle")}
      labelledBy={paper ? titleId : undefined}
      fallbackFocus={fallbackFocus}
    >
      {isLoading && <Skeleton lines={8} />}
      {isError && <p className="pd-error">{t("paper.notFound")}</p>}

      {paper && (
        <div className="pd" data-testid="paper-details">
          <h2 id={titleId} className="pd-title">
            {paper.title}
          </h2>

          <div className="pd-badges">
            {paper.open_access && <span className="badge">{t("paper.openAccess")}</span>}
            {inLibrary && (
              <span className="badge badge--success">{t("paper.inLibrary")}</span>
            )}
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
          {paper.cited_by_count != null && paper.provider_source && (
            <p className="pd-count-source">
              {t("paper.citationsFrom", { provider: providerLabel(paper.provider_source) })}
            </p>
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
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => saveMutation.mutate()}
                  disabled={inLibrary || saveMutation.isPending}
                >
                  <BookMarked size={14} />
                  {inLibrary ? t("paper.inLibrary") : t("paper.saveToLibrary")}
                </button>
                <AddToCollectionMenu
                  canonicalKey={paper.canonical_key}
                  savedInCollections={memberships?.[paper.canonical_key] ?? []}
                />
              </>
            )}
          </div>

          {paragraphs.length > 0 && (
            <section className="pd-section">
              <h3>{t("paper.abstractHeading")}</h3>
              <div className="pd-abstract">
                {paragraphs.map((paragraph, index) => (
                  <p key={index}>
                    {paragraph.label && <strong>{`${paragraph.label}: `}</strong>}
                    {paragraph.text}
                  </p>
                ))}
              </div>
            </section>
          )}

          {(paper.doi || paper.arxiv_id || fullText.length > 0) && (
            <section className="pd-section">
              <h3>{t("paper.linksHeading")}</h3>
              <div className="pd-links">
                {paper.doi && (
                  <ExternalLinkChip href={`https://doi.org/${paper.doi}`}>
                    {t("paper.publisherLink")}
                  </ExternalLinkChip>
                )}
                {paper.arxiv_id && (
                  <ExternalLinkChip href={`https://arxiv.org/abs/${paper.arxiv_id}`}>
                    arXiv
                  </ExternalLinkChip>
                )}
                {fullText.map((link) => (
                  <ExternalLinkChip
                    key={link.url}
                    href={link.url}
                    icon={link.kind === "pdf" ? <FileDown size={12} aria-hidden="true" /> : undefined}
                  >
                    {link.kind === "pdf" ? t("paper.downloadPdf") : t("paper.fullText")}
                  </ExternalLinkChip>
                ))}
              </div>
            </section>
          )}

          {(paper.topics.length > 0 || paper.keywords.length > 0) && (
            <div className="pd-topics">
              {[...paper.topics, ...paper.keywords].slice(0, 8).map((topic) => (
                <span key={topic} className="badge badge--neutral">
                  {topic}
                </span>
              ))}
            </div>
          )}

          {entry && entry.pinned_versions.length > 0 ? (
            <section className="pd-section" data-testid="managed-versions">
              <h3>{t("library.pinnedVersions")}</h3>
              <ul className="pd-versions">
                {entry.pinned_versions.map((pin, index) => {
                  const isPrimary = pin.paper_canonical_key === entry.primary_canonical_key;
                  const labelId = `${titleId}-pin-${index}`;
                  return (
                    <li
                      key={pin.paper_canonical_key}
                      className={isPrimary ? "pd-version active" : "pd-version"}
                    >
                      <VersionText id={labelId} info={pinLabel(pin, labels)} />
                      <span className="pd-version-actions">
                        {isPrimary ? (
                          <span className="badge">{t("library.primary")}</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={repinMutation.isPending}
                              onClick={() => repinMutation.mutate(pin.paper_canonical_key)}
                              title={t("library.repinTitle")}
                              aria-label={t("library.repinTitle")}
                              aria-describedby={labelId}
                            >
                              <Pin size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={removeVersionMutation.isPending}
                              onClick={() =>
                                removeVersionMutation.mutate(pin.paper_canonical_key)
                              }
                              title={t("library.removeVersionTitle")}
                              aria-label={t("library.removeVersionTitle")}
                              aria-describedby={labelId}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : (
            paper.versions.length > 1 && (
              <section className="pd-section">
                <h3>{t("paper.versionsHeading")}</h3>
                <ul className="pd-versions">
                  {paper.versions.map((version) => {
                    const info = labels.get(version.canonical_key);
                    return (
                      <li
                        key={version.canonical_key}
                        className={
                          version.canonical_key === paper.canonical_key
                            ? "pd-version active"
                            : "pd-version"
                        }
                      >
                        {info && <VersionText info={info} />}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )
          )}

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
    </Panel>
  );
}
