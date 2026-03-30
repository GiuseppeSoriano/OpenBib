import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import type { RecommendationResponse } from "@/types";
import { Sparkles, GitFork } from "lucide-react";
import "./RecommendationsPage.css";

export default function RecommendationsPage() {
  const [key, setKey] = useState("");
  const [searchKey, setSearchKey] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["recommendations", searchKey],
    queryFn: async () => {
      const { data } = await api.get<RecommendationResponse>(
        `/recommendations/${encodeURIComponent(searchKey)}`,
        { params: { limit: 20 } },
      );
      return data;
    },
    enabled: !!searchKey,
  });

  const handleSearch = () => {
    if (key.trim()) setSearchKey(key.trim());
  };

  return (
    <div className="recommendations-page">
      <h1>
        <Sparkles size={20} />
        Recommendations
      </h1>
      <p className="rec-subtitle">
        Find similar papers based on co-citation analysis. Enter a paper key to get started.
      </p>

      <div className="rec-search">
        <input
          className="input"
          placeholder="Enter a DOI or canonical key…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button className="btn btn-primary" onClick={handleSearch}>
          Get recommendations
        </button>
      </div>

      {isLoading && <p className="rec-status">Finding similar papers…</p>}

      {data && data.recommendations.length === 0 && (
        <p className="rec-status">
          No recommendations found. This paper may not have citation data yet.
          Try exploring its graph first to populate edges.
        </p>
      )}

      {data && data.recommendations.length > 0 && (
        <div className="rec-results">
          <p className="rec-meta">
            {data.recommendations.length} recommendations for{" "}
            <strong>{data.paper_key}</strong>
          </p>
          <div className="rec-list">
            {data.recommendations.map((rec) => (
              <div key={rec.canonical_key} className="card rec-item">
                <div className="rec-item-header">
                  <h3>{rec.title}</h3>
                  <span className="rec-score badge">Score: {rec.score}</span>
                </div>
                <p className="rec-reason">{rec.reason}</p>
                <div className="rec-item-actions">
                  <Link
                    to={`/graph/${encodeURIComponent(rec.canonical_key)}`}
                    className="btn btn-secondary"
                    style={{ fontSize: "0.8rem", padding: "3px 8px" }}
                  >
                    <GitFork size={12} />
                    Explore graph
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
