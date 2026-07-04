import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Skeleton from "@/components/ui/Skeleton";
import type { Collection, UserStats } from "@/types";
import { BookMarked, FolderOpen, Search } from "lucide-react";
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

  const statValue = (value: number | undefined) =>
    statsLoading ? <Skeleton width="2.5rem" height="1.6rem" /> : <span className="stat-value">{value ?? 0}</span>;

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

      {/* Stats */}
      <div className="dashboard-stats">
        <div className="stat-card card">
          {statValue(stats?.total_collections ?? collections?.length)}
          <span className="stat-label">{t("dashboard.statCollections")}</span>
        </div>
        <div className="stat-card card">
          {statValue(stats?.library_total)}
          <span className="stat-label">{t("dashboard.statInLibrary")}</span>
        </div>
        <div className="stat-card card">
          {statValue(stats?.total_papers)}
          <span className="stat-label">{t("dashboard.statTotalSaves")}</span>
        </div>
        <div className="stat-card card">
          {statValue(stats?.distinct_papers)}
          <span className="stat-label">{t("dashboard.statUniquePapers")}</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <Link to="/search" className="dashboard-action card">
          <Search size={24} />
          <h3>{t("dashboard.searchTitle")}</h3>
          <p>{t("dashboard.searchDesc")}</p>
        </Link>

        <Link to="/collections" className="dashboard-action card">
          <FolderOpen size={24} />
          <h3>{t("dashboard.collectionsTitle")}</h3>
          <p>
            {collections
              ? t("dashboard.collectionsCount", { count: collections.length })
              : t("dashboard.collectionsFallback")}
          </p>
        </Link>

        <Link to="/library" className="dashboard-action card">
          <BookMarked size={24} />
          <h3>{t("dashboard.libraryTitle")}</h3>
          <p>
            {stats
              ? t("dashboard.libraryCount", { count: stats.library_total })
              : t("dashboard.libraryFallback")}
          </p>
        </Link>

      </div>

      {collectionsLoading && (
        <section className="dashboard-recent">
          <Skeleton height="4rem" lines={3} />
        </section>
      )}

      {collections && collections.length > 0 && (
        <section className="dashboard-recent">
          <h2>{t("dashboard.recent")}</h2>
          <div className="collection-list">
            {collections.slice(0, 5).map((c) => (
              <Link to={`/collections/${c.id}`} key={c.id} className="card collection-card">
                <div className="collection-card-header">
                  <h4>{c.name}</h4>
                  <span className="badge">{t(`collections.visibility${c.visibility.charAt(0).toUpperCase()}${c.visibility.slice(1)}`)}</span>
                </div>
                {c.description && (
                  <p className="collection-desc">{c.description}</p>
                )}
                <span className="collection-meta">
                  {t("dashboard.paperCount", { count: c.paper_count })}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
