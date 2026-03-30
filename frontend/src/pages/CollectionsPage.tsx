import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import type { Collection, Visibility } from "@/types";
import { Plus, Trash2 } from "lucide-react";
import "./CollectionsPage.css";

export default function CollectionsPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");

  const { data: collections, isLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<{ items: Collection[] }>("/collections");
      return data.items;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await api.post("/collections", { name, description: description || null, visibility });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      setShowForm(false);
      setName("");
      setDescription("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/collections/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) createMutation.mutate();
  };

  return (
    <div className="collections-page">
      <div className="page-header">
        <h1>Collections</h1>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          <Plus size={16} />
          New collection
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card create-form">
          <input
            className="input"
            placeholder="Collection name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <input
            className="input"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <select
            className="input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
          >
            <option value="private">Private</option>
            <option value="shared">Shared</option>
            <option value="public">Public</option>
          </select>
          <div className="create-form-actions">
            <button type="submit" className="btn btn-primary">
              Create
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading && <p className="loading-text">Loading collections…</p>}

      <div className="collection-grid">
        {collections?.map((c) => (
          <div key={c.id} className="card collection-item">
            <Link to={`/collections/${c.id}`} className="collection-link">
              <h3>{c.name}</h3>
              {c.description && <p>{c.description}</p>}
              <div className="collection-item-meta">
                <span className="badge">{c.visibility}</span>
                <span>
                  {c.paper_count} paper{c.paper_count !== 1 ? "s" : ""}
                </span>
              </div>
            </Link>
            <button
              className="btn-ghost delete-btn"
              onClick={() => {
                if (confirm(`Delete "${c.name}"?`)) deleteMutation.mutate(c.id);
              }}
              title="Delete collection"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {collections && collections.length === 0 && (
        <p className="loading-text">
          No collections yet. Create one to start organizing your references.
        </p>
      )}
    </div>
  );
}
