import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [saved, setSaved] = useState(false);

  const updateMutation = useMutation({
    mutationFn: async () => {
      await api.patch("/users/me", { display_name: displayName || null });
    },
    onSuccess: () => setSaved(true),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await api.delete("/users/me");
    },
    onSuccess: () => logout(),
  });

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    updateMutation.mutate();
  };

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 600, marginBottom: "1.5rem" }}>
        Settings
      </h1>

      <form onSubmit={handleSave} className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          Email
          <input className="input" value={user?.email ?? ""} disabled />
        </label>
        <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          Display name
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" style={{ alignSelf: "flex-start" }}>
          Save changes
        </button>
        {saved && (
          <span style={{ color: "var(--color-accent)", fontSize: "0.85rem" }}>
            Saved!
          </span>
        )}
      </form>

      <div style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", color: "#c53030" }}>
          Danger zone
        </h2>
        <button
          className="btn btn-secondary"
          style={{ borderColor: "#c53030", color: "#c53030" }}
          onClick={() => {
            if (confirm("Permanently delete your account? This cannot be undone.")) {
              deleteMutation.mutate();
            }
          }}
        >
          Delete account
        </button>
      </div>
    </div>
  );
}
