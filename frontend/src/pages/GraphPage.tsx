import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import type { GraphResponse } from "@/types";
import "./GraphPage.css";

export default function GraphPage() {
  const { paperKey } = useParams<{ paperKey: string }>();
  const [key, setKey] = useState(paperKey ?? "");
  const [searchKey, setSearchKey] = useState(paperKey ?? "");

  const { data, isLoading } = useQuery({
    queryKey: ["graph", searchKey],
    queryFn: async () => {
      const { data } = await api.get<GraphResponse>(`/graph/${encodeURIComponent(searchKey)}`, {
        params: { depth: 2, max_nodes: 50 },
      });
      return data;
    },
    enabled: !!searchKey,
  });

  const handleExplore = () => {
    if (key.trim()) setSearchKey(key.trim());
  };

  return (
    <div className="graph-page">
      <h1>Citation Graph</h1>

      <div className="graph-search">
        <input
          className="input"
          placeholder="Enter a paper canonical key or DOI…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleExplore()}
        />
        <button className="btn btn-primary" onClick={handleExplore}>
          Explore
        </button>
      </div>

      {isLoading && <p className="graph-status">Loading graph…</p>}

      {data && (
        <div className="graph-container card">
          {data.nodes.length === 0 ? (
            <p className="graph-status">
              No graph data found for this paper. Try searching and viewing a
              paper first to populate citation data.
            </p>
          ) : (
            <div className="graph-info">
              <p>
                <strong>{data.nodes.length}</strong> nodes,{" "}
                <strong>{data.edges.length}</strong> edges
              </p>
              <div className="graph-node-list">
                {data.nodes.slice(0, 20).map((n) => (
                  <div key={n.key} className="graph-node-item">
                    <span className="graph-node-dot" />
                    <span>{n.label || n.key}</span>
                  </div>
                ))}
                {data.nodes.length > 20 && (
                  <p className="graph-more">
                    and {data.nodes.length - 20} more…
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!searchKey && (
        <p className="graph-status">
          Enter a paper key above to explore its citation neighborhood.
        </p>
      )}
    </div>
  );
}
