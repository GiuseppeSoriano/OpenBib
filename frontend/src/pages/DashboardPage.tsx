import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import type { Collection, UserStats } from "@/types";
import { ArrowRight, FolderOpen } from "lucide-react";
import "./DashboardPage.css";

export default function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const { data: collections, isLoading: collectionsLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
  });

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["user-stats"],
    queryFn: async () => {
      const { data } = await api.get<UserStats>("/users/me/stats");
      return data;
    },
  });

  const stat = (value: number | undefined, label: string) => (
    <div className="stat-tile card">
      {statsLoading ? (
        <Skeleton width="2.4rem" height="1.5rem" />
      ) : (
        <span className="stat-value">{value ?? 0}</span>
      )}
      <span className="stat-label">{label}</span>
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

      <div className="dashboard-stats">
        {stat(stats?.total_collections ?? collections?.length, t("dashboard.statCollections"))}
        {stat(stats?.library_total, t("dashboard.statInLibrary"))}
        {stat(stats?.total_papers, t("dashboard.statTotalSaves"))}
        {stat(stats?.distinct_papers, t("dashboard.statUniquePapers"))}
      </div>

      <section className="dashboard-recent">
        <div className="dashboard-recent-head">
          <h2>{t("dashboard.recent")}</h2>
          <Link to="/collections" className="btn-ghost dashboard-viewall">
            {t("dashboard.viewAll")}
            <ArrowRight size={14} />
          </Link>
        </div>

        {collectionsLoading && <Skeleton height="4rem" lines={3} />}

        {collections && collections.length === 0 && (
          <EmptyState
            icon={FolderOpen}
            title={t("collections.emptyTitle")}
            description={t("collections.emptyDescription")}
            action={
              <Link to="/collections" className="btn btn-primary">
                {t("collections.new")}
              </Link>
            }
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
                  {t(
                    `collections.visibility${c.visibility.charAt(0).toUpperCase()}${c.visibility.slice(1)}`,
                  )}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
