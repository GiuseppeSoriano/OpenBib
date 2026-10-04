import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import api, { library } from "@/lib/api";
import { PHONE_QUERY } from "@/lib/breakpoints";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useLegalConfig } from "@/lib/legal";
import { useAuth } from "@/contexts/AuthContext";
import { useCollectionsList } from "@/components/shell/navItems";
import { TopBarActions } from "@/components/shell/ShellContext";
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/ui/QueryError";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import type { LibraryEntryListItem, LibraryFacets, ReadingState, UserStats } from "@/types";
import { ArrowRight, FolderOpen, FolderPlus, Search } from "lucide-react";
import "./DashboardPage.css";

const CONTINUE_LIMIT = 5;
const RECENT_LIMIT = 5;
const COLLECTIONS_LIMIT = 6;

// Saving a paper or changing a reading state elsewhere does not always invalidate these, so the
// dashboard refetches them on every visit.
const FRESH = { staleTime: 0, refetchOnMount: "always" } as const;

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 hours ago", "yesterday", "3 weeks ago" in the UI language. */
function relativeTime(iso: string, language: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "second");
}

function greetingKey(hour: number) {
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 18) return "Afternoon";
  return "Evening";
}

/** Authors (family names), venue and year, as in a table of contents. */
function paperMeta(item: LibraryEntryListItem, t: TFunction): string {
  const paper = item.primary_version;
  if (!paper) return "";
  const names = paper.authors.map((author) => author.family_name || author.name).filter(Boolean);
  const authors =
    names.length > 4 ? t("dashboard.authorsEtAl", { names: names.slice(0, 3).join(", ") }) : names.join(", ");
  const year = paper.publication_date?.slice(0, 4);
  return [authors, paper.venue, year].filter(Boolean).join(" · ");
}

function entryTitle(item: LibraryEntryListItem): string {
  return item.primary_version?.title || item.primary_canonical_key;
}

function entryLink(item: LibraryEntryListItem): string {
  return `/library?focus=${encodeURIComponent(item.paper_group_key)}`;
}

function stateCount(facets: LibraryFacets | undefined, state: ReadingState): number {
  return facets?.states.find((entry) => entry.state === state)?.count ?? 0;
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { data: legal } = useLegalConfig();
  const { data: collections, isLoading: collectionsLoading } = useCollectionsList(true);
  // Phones already reach search from the top bar's icon and the Search tab.
  const isPhone = useMediaQuery(PHONE_QUERY);

  // The onboarding card and export reminder depend on the stats: refetch on every visit.
  const {
    data: stats,
    isLoading: statsLoading,
    isFetching: statsFetching,
  } = useQuery({
    queryKey: ["user-stats"],
    queryFn: async () => {
      const { data } = await api.get<UserStats>("/users/me/stats");
      return data;
    },
    ...FRESH,
  });

  const emptyAccount = !!stats && stats.library_total === 0 && stats.total_collections === 0;
  // A cached empty result waits for the refetch, so the onboarding never flashes for a returning
  // user nor lingers after a new user's first save.
  const statsPending = statsLoading || (emptyAccount && statsFetching);
  const isNewUser = emptyAccount && !statsFetching;
  const hasLibrary = !statsPending && (stats?.library_total ?? 0) > 0;
  // The onboarding card already offers both first steps; keep Collections only for shared ones.
  const showCollections = !isNewUser || !!collections?.length;
  const showExportReminder = legal?.backups_enabled === false && (stats?.library_total ?? 0) > 0;

  // Same key as the Library filters, so their reading-state counts stay in step.
  const facetsQuery = useQuery({
    queryKey: ["library-entries", "facets"],
    queryFn: () => library.getFacets(),
    enabled: hasLibrary,
    ...FRESH,
  });
  const readingQuery = useQuery({
    queryKey: ["library-entries", "dashboard", "reading"],
    queryFn: () => library.listEntries({ state: "reading", size: CONTINUE_LIMIT }),
    enabled: hasLibrary,
    ...FRESH,
  });
  const toReadQuery = useQuery({
    queryKey: ["library-entries", "dashboard", "to_read"],
    queryFn: () => library.listEntries({ state: "to_read", size: CONTINUE_LIMIT }),
    enabled: hasLibrary,
    ...FRESH,
  });
  const recentQuery = useQuery({
    queryKey: ["library-entries", "dashboard", "recent"],
    queryFn: () => library.listEntries({ sort: "added", size: RECENT_LIMIT }),
    enabled: hasLibrary,
    ...FRESH,
  });

  const facets = facetsQuery.data;
  // Papers being read first, then the reading list; an entry in both states shows once.
  const inProgress = useMemo(() => {
    const seen = new Set<string>();
    const rows: { item: LibraryEntryListItem; state: "reading" | "to_read" }[] = [];
    const groups = [
      ["reading", readingQuery.data?.items ?? []],
      ["to_read", toReadQuery.data?.items ?? []],
    ] as const;
    for (const [state, items] of groups) {
      for (const item of items) {
        if (seen.has(item.paper_group_key)) continue;
        seen.add(item.paper_group_key);
        rows.push({ item, state });
      }
    }
    return rows.slice(0, CONTINUE_LIMIT);
  }, [readingQuery.data, toReadQuery.data]);

  const now = Date.now();
  // The resolved code ("en"/"it"), never a raw detected tag that Intl may reject.
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const greeting = `dashboard.greeting${greetingKey(new Date(now).getHours())}`;
  const dateLine = new Intl.DateTimeFormat(language, { weekday: "long", day: "numeric", month: "long" }).format(
    now,
  );

  const firstSteps = (searchLabel: string) => (
    <div className="dashboard-actions">
      <Link to="/search" className="btn btn-primary">
        <Search size={15} aria-hidden="true" />
        {searchLabel}
      </Link>
      <Link to="/collections" className="btn btn-secondary">
        <FolderPlus size={15} aria-hidden="true" />
        {t("collections.new")}
      </Link>
    </div>
  );

  // `null` is an unknown value (its query failed): a dash, never a misleading 0.
  const figure = (label: string, value: number | null | undefined, pending: boolean) => (
    <div className="dashboard-figure">
      <dt className="dashboard-figure-label">{label}</dt>
      <dd className="dashboard-figure-value tabular">
        {pending ? <Skeleton width="2.4rem" height="1.5rem" /> : value === null ? "–" : number(value ?? 0)}
      </dd>
    </div>
  );
  const facetsPending = hasLibrary && facetsQuery.isLoading;
  const facetsFailed = hasLibrary && facetsQuery.isError;
  const figures = (
    <dl className="dashboard-figures">
      {figure(t("dashboard.statInLibrary"), stats?.library_total, statsPending)}
      {figure(t("dashboard.statCollections"), stats?.total_collections ?? collections?.length, statsPending)}
      {figure(
        t("dashboard.statReading"),
        facetsFailed ? null : stateCount(facets, "reading"),
        statsPending || facetsPending,
      )}
      {figure(
        t("dashboard.statToRead"),
        facetsFailed ? null : stateCount(facets, "to_read"),
        statsPending || facetsPending,
      )}
    </dl>
  );

  // An entry can carry several states across its versions, so the bar scales to whichever is larger.
  const progress = (() => {
    const toRead = stateCount(facets, "to_read");
    const reading = stateCount(facets, "reading");
    const read = stateCount(facets, "read");
    const total = facets?.total ?? 0;
    const other = Math.max(0, total - toRead - reading - read);
    const scale = Math.max(total, toRead + reading + read + other);
    const parts = [
      { key: "toread", label: t("paper.states.to_read"), count: toRead },
      { key: "reading", label: t("paper.states.reading"), count: reading },
      { key: "read", label: t("paper.states.read"), count: read },
      { key: "other", label: t("dashboard.progressOther"), count: other },
    ];
    let x = 0;
    const segments = parts.map((part) => {
      const width = scale ? (part.count / scale) * 100 : 0;
      const segment = { ...part, x, width };
      x += width;
      return segment;
    });
    const label = t("dashboard.progressLabel", {
      toRead: number(toRead),
      reading: number(reading),
      read: number(read),
      other: number(other),
    });
    return { segments, label };
  })();

  const greetingText = user?.display_name
    ? t(`${greeting}Named`, { name: user.display_name })
    : t(greeting);

  return (
    <div className="dashboard">
      {!statsPending && !isNewUser && !isPhone && (
        <TopBarActions>
          <Link to="/search" className="btn btn-primary">
            <Search size={15} aria-hidden="true" />
            {t("dashboard.findPapers")}
          </Link>
        </TopBarActions>
      )}

      <PageHeader
        className="dashboard-header"
        display
        eyebrow={dateLine}
        title={greetingText}
        description={isNewUser ? undefined : t("dashboard.figuresNote")}
        actions={isNewUser ? undefined : figures}
      />

      {isNewUser && (
        <section className="dashboard-onboarding" aria-labelledby="dashboard-get-started">
          <SectionHeading id="dashboard-get-started" title={t("dashboard.getStartedTitle")} />
          <p className="dashboard-onboarding-intro">{t("dashboard.getStartedIntro")}</p>
          <ol className="list-rows dashboard-steps">
            {[t("dashboard.getStartedSearch"), t("dashboard.getStartedSave"), t("dashboard.getStartedOrganize")].map(
              (step, index) => (
                <li key={step} className="list-row dashboard-numbered">
                  <span className="dashboard-index tabular" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{step}</span>
                </li>
              ),
            )}
          </ol>
          {firstSteps(t("dashboard.findFirstPaper"))}
        </section>
      )}

      {hasLibrary && (
        <div className="dashboard-columns">
          <section className="dashboard-continue" aria-labelledby="dashboard-continue">
            <SectionHeading
              id="dashboard-continue"
              title={t("dashboard.continueReading")}
              action={
                <Link to="/library?state=reading" className="dashboard-more">
                  {t("dashboard.allInProgress")}
                  <ArrowRight size={14} aria-hidden="true" />
                </Link>
              }
            />
            {readingQuery.isLoading || toReadQuery.isLoading ? (
              <Skeleton height="4rem" lines={3} />
            ) : readingQuery.isError || toReadQuery.isError ? (
              <QueryError
                onRetry={() => {
                  void readingQuery.refetch();
                  void toReadQuery.refetch();
                }}
                busy={readingQuery.isFetching || toReadQuery.isFetching}
              />
            ) : inProgress.length === 0 ? (
              <p className="dashboard-quiet">{t("dashboard.continueEmpty")}</p>
            ) : (
              <ol className="list-rows list-rows--interactive">
                {inProgress.map(({ item, state }, index) => {
                  const meta = paperMeta(item, t);
                  return (
                    <li key={item.paper_group_key} className="list-row dashboard-numbered">
                      <span className="dashboard-index tabular" aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="dashboard-continue-body">
                        <Link to={entryLink(item)} className="row-title dashboard-continue-title">
                          {entryTitle(item)}
                        </Link>
                        {meta && <p className="row-meta">{meta}</p>}
                      </div>
                      <span className={`state-pill state-pill--${state === "reading" ? "reading" : "toread"}`}>
                        {t(`paper.states.${state}`)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <div className="dashboard-side">
            <section aria-labelledby="dashboard-progress">
              <SectionHeading id="dashboard-progress" title={t("dashboard.progressTitle")} />
              {facetsQuery.isLoading ? (
                <Skeleton height="1.5rem" />
              ) : facetsQuery.isError ? (
                <QueryError onRetry={() => void facetsQuery.refetch()} busy={facetsQuery.isFetching} />
              ) : (
                <>
                  <div className="dashboard-progress" role="img" aria-label={progress.label}>
                    <svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                      {progress.segments.map((segment) =>
                        segment.width > 0 ? (
                          <rect
                            key={segment.key}
                            className={`dashboard-progress-${segment.key}`}
                            x={segment.x}
                            y={0}
                            width={segment.width}
                            height={1}
                          />
                        ) : null,
                      )}
                    </svg>
                  </div>
                  <ul className="dashboard-legend">
                    {progress.segments.map((segment) => (
                      <li key={segment.key}>
                        <span className={`dashboard-swatch dashboard-swatch--${segment.key}`} aria-hidden="true" />
                        <span className="dashboard-legend-label">{segment.label}</span>
                        <span className="dashboard-legend-count tabular">{number(segment.count)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section aria-labelledby="dashboard-recently-saved">
              <SectionHeading id="dashboard-recently-saved" title={t("dashboard.recentlySaved")} />
              {recentQuery.isLoading ? (
                <Skeleton height="1.5rem" lines={3} />
              ) : recentQuery.isError ? (
                <QueryError onRetry={() => void recentQuery.refetch()} busy={recentQuery.isFetching} />
              ) : (
                <ul className="list-rows">
                  {(recentQuery.data?.items ?? []).map((item) => (
                    <li key={item.paper_group_key} className="list-row dashboard-recent-row">
                      <Link to={entryLink(item)} className="dashboard-recent-title">
                        {entryTitle(item)}
                      </Link>
                      <time className="dashboard-when" dateTime={item.created_at}>
                        {relativeTime(item.created_at, language, now)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {showExportReminder && (
              <p className="margin-note dashboard-backup-note">
                {t("dashboard.exportReminder")}{" "}
                <Link to="/settings#your-data">{t("dashboard.exportReminderLink")}</Link>
              </p>
            )}
          </div>
        </div>
      )}

      {showCollections && (
        <section className="dashboard-collections" aria-labelledby="dashboard-collections">
          <SectionHeading
            id="dashboard-collections"
            title={t("dashboard.collectionsTitle")}
            action={
              <Link to="/collections" className="dashboard-more">
                {t("dashboard.viewAll")}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            }
          />

          {(collectionsLoading || (collections?.length === 0 && statsPending)) && (
            <Skeleton height="1.5rem" lines={3} />
          )}

          {/* Wait for the stats: a new user gets these steps from the onboarding card. */}
          {collections && collections.length === 0 && !statsPending && (
            <EmptyState
              icon={FolderOpen}
              title={t("collections.emptyTitle")}
              description={t("collections.emptyDescription")}
              action={firstSteps(t("dashboard.findPapers"))}
            />
          )}

          {collections && collections.length > 0 && (
            <div className="data-table-wrap">
              <table className="data-table dashboard-table" aria-labelledby="dashboard-collections">
                <thead>
                  <tr>
                    <th scope="col">{t("dashboard.columnName")}</th>
                    <th scope="col" className="num">
                      {t("dashboard.columnPapers")}
                    </th>
                    <th scope="col" className="dashboard-col-wide">
                      {t("dashboard.columnAccess")}
                    </th>
                    <th scope="col" className="num dashboard-col-wide">
                      {t("dashboard.columnUpdated")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {collections.slice(0, COLLECTIONS_LIMIT).map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/collections/${c.id}`} className="dashboard-table-name">
                          {c.name}
                        </Link>
                      </td>
                      <td className="num">{number(c.paper_count)}</td>
                      <td className="dashboard-col-wide dashboard-access">
                        {t(c.is_owner ? "sharing.owner" : c.can_edit ? "sharing.editor" : "sharing.reader")}
                      </td>
                      <td className="num muted dashboard-col-wide">
                        <time dateTime={c.updated_at}>{relativeTime(c.updated_at, language, now)}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
