import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Collection } from "@/types";
import { FolderOpen, Search, GitFork } from "lucide-react";
import "./DashboardPage.css";

export default function DashboardPage() {
  const { user } = useAuth();

  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<{ items: Collection[] }>("/collections");
      return data.items;
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
