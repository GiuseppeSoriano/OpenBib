import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Collection, UserStats } from "@/types";
import { BookMarked, FolderOpen, Search, GitFork } from "lucide-react";
import "./DashboardPage.css";

export default function DashboardPage() {
  const { user } = useAuth();

  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
  });

  const { data: stats } = useQuery({
    queryKey: ["user-stats"],
    queryFn: async () => {
      const { data } = await api.get<UserStats>("/users/me/stats");
      return data;
    },
  });

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>
          Welcome{user?.display_name ? `, ${user.display_name}` : ""}
        </h1>
        <p>Your academic reference workspace</p>
      </header>

      {/* Stats */}
      <div className="dashboard-stats">
        <div className="stat-card card">
          <span className="stat-value">{stats?.total_collections ?? collections?.length ?? 0}</span>
          <span className="stat-label">Collections</span>
        </div>
        <div className="stat-card card">
          <span className="stat-value">{stats?.library_total ?? 0}</span>
          <span className="stat-label">In Library</span>
        </div>
        <div className="stat-card card">
          <span className="stat-value">{stats?.total_papers ?? 0}</span>
          <span className="stat-label">Total saves</span>
        </div>
        <div className="stat-card card">
          <span className="stat-value">{stats?.distinct_papers ?? 0}</span>
          <span className="stat-label">Unique papers</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <Link to="/search" className="dashboard-action card">
          <Search size={24} />
          <h3>Search papers</h3>
          <p>Search across OpenAlex, arXiv, Crossref, and Europe PMC</p>
        </Link>

        <Link to="/collections" className="dashboard-action card">
          <FolderOpen size={24} />
          <h3>Collections</h3>
          <p>
            {collections
              ? `${collections.length} collection${collections.length !== 1 ? "s" : ""}`
              : "Organize your references"}
          </p>
        </Link>

        <Link to="/library" className="dashboard-action card">
          <BookMarked size={24} />
          <h3>Library</h3>
          <p>
            {stats
              ? `${stats.library_total} paper${stats.library_total !== 1 ? "s" : ""} archived`
              : "Your persistent paper archive"}
          </p>
        </Link>

        <Link to="/graph" className="dashboard-action card">
          <GitFork size={24} />
          <h3>Citation graph</h3>
          <p>Explore citation networks visually</p>
        </Link>

      </div>

      {collections && collections.length > 0 && (
        <section className="dashboard-recent">
          <h2>Recent collections</h2>
          <div className="collection-list">
            {collections.slice(0, 5).map((c) => (
              <Link to={`/collections/${c.id}`} key={c.id} className="card collection-card">
                <div className="collection-card-header">
                  <h4>{c.name}</h4>
                  <span className="badge">{c.visibility}</span>
                </div>
                {c.description && (
                  <p className="collection-desc">{c.description}</p>
                )}
                <span className="collection-meta">
                  {c.paper_count} paper{c.paper_count !== 1 ? "s" : ""}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
