import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import type { Collection } from "@/types";

export default function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: collection, isLoading } = useQuery({
    queryKey: ["collection", id],
    queryFn: async () => {
      const { data } = await api.get<Collection>(`/collections/${id}`);
      return data;
    },
    enabled: !!id,
  });

  if (isLoading) return <p style={{ padding: "2rem" }}>Loading…</p>;
  if (!collection) return <p style={{ padding: "2rem" }}>Collection not found</p>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 600 }}>{collection.name}</h1>
        <span className="badge">{collection.visibility}</span>
      </div>
      {collection.description && (
        <p style={{ color: "var(--color-text-secondary)", marginBottom: "1.5rem" }}>
          {collection.description}
        </p>
      )}
      <p style={{ color: "var(--color-warm-gray)", fontSize: "0.85rem" }}>
        {collection.paper_count} paper{collection.paper_count !== 1 ? "s" : ""} ·
        Created {new Date(collection.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}
