import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { useLegalConfig } from "@/lib/legal";
import { useAuth } from "@/contexts/AuthContext";
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import type { Collection, UserStats } from "@/types";
import { ArrowRight, Download, FolderOpen, FolderPlus, Search } from "lucide-react";
import "./DashboardPage.css";

export default function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: legal } = useLegalConfig();

  const { data: collections, isLoading: collectionsLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
  });

  // Saving a paper or creating a collection elsewhere does not invalidate the stats, so refetch
  // on every visit: the onboarding card and export reminder depend on them.
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
    staleTime: 0,
    refetchOnMount: "always",
  });

  const emptyAccount = !!stats && stats.library_total === 0 && stats.total_collections === 0;
  // A cached empty result waits for the refetch, so the onboarding never flashes for a returning
  // user nor lingers after a new user's first save.
  const statsPending = statsLoading || (emptyAccount && statsFetching);
  const isNewUser = emptyAccount && !statsFetching;
  // The onboarding card already offers both first steps; keep Recent only for shared collections.
  const showRecent = !isNewUser || !!collections?.length;
  const showExportReminder = legal?.backups_enabled === false && (stats?.library_total ?? 0) > 0;

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

  const stat = (value: number | undefined, label: string, hint: string) => (
    <div className="stat-tile card">
      {statsPending ? (
        <Skeleton width="2.4rem" height="1.5rem" />
      ) : (
        <span className="stat-value">{value ?? 0}</span>
      )}
      <span className="stat-label">{label}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>
          {user?.display_name
            ? t("dashboard.welcomeNamed", { name: user.display_name })
            : t("dashboard.welcome")}
        </h1>
        <p>{t("dashboard.subtitle")}</p>
      </header>

      {isNewUser ? (
        <section className="card dashboard-onboarding" aria-labelledby="dashboard-get-started">
          <h2 id="dashboard-get-started">{t("dashboard.getStartedTitle")}</h2>
          <p>{t("dashboard.getStartedIntro")}</p>
          <ol className="dashboard-steps">
            <li>{t("dashboard.getStartedSearch")}</li>
            <li>{t("dashboard.getStartedSave")}</li>
            <li>{t("dashboard.getStartedOrganize")}</li>
          </ol>
          {firstSteps(t("dashboard.findFirstPaper"))}
        </section>
      ) : (
        <div className="dashboard-stats">
          {stat(stats?.library_total, t("dashboard.statInLibrary"), t("dashboard.statInLibraryHint"))}
          {stat(
            stats?.total_collections ?? collections?.length,
            t("dashboard.statCollections"),
            t("dashboard.statCollectionsHint"),
          )}
          {stat(stats?.total_papers, t("dashboard.statTotalSaves"), t("dashboard.statTotalSavesHint"))}
          {stat(
            stats?.distinct_papers,
            t("dashboard.statUniquePapers"),
            t("dashboard.statUniquePapersHint"),
          )}
        </div>
      )}

      {showExportReminder && (
        <aside className="card dashboard-export-reminder">
          <Download size={16} aria-hidden="true" />
          <p>
            {t("dashboard.exportReminder")}{" "}
            <Link to="/settings#your-data">{t("dashboard.exportReminderLink")}</Link>
          </p>
        </aside>
      )}

      {showRecent && (
        <section className="dashboard-recent">
          <div className="dashboard-recent-head">
            <h2>{t("dashboard.recent")}</h2>
            <Link to="/collections" className="btn-ghost dashboard-viewall">
              {t("dashboard.viewAll")}
              <ArrowRight size={14} />
            </Link>
          </div>

          {(collectionsLoading || (collections?.length === 0 && statsPending)) && (
            <Skeleton height="4rem" lines={3} />
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
            <div className="dashboard-collections">
              {collections.slice(0, 6).map((c) => (
                <Link to={`/collections/${c.id}`} key={c.id} className="card dashboard-collection">
                  <h3>{c.name}</h3>
                  {c.description && <p className="dashboard-collection-desc">{c.description}</p>}
                  <span className="dashboard-collection-meta">
                    {t("dashboard.paperCount", { count: c.paper_count })} ·{" "}
                    {t(c.is_owner ? "sharing.owner" : c.can_edit ? "sharing.editor" : "sharing.reader")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
