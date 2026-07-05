import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import ThemeToggle from "@/components/ui/ThemeToggle";
import LanguageSwitcher from "@/components/ui/LanguageSwitcher";
import { useToast } from "@/components/ui/Toast";
import { BookUp, CheckCircle2 } from "lucide-react";
import api, { zotero } from "@/lib/api";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user, logout, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [saved, setSaved] = useState(false);

  const updateMutation = useMutation({
    mutationFn: async () => {
      await api.patch("/users/me", { display_name: displayName || null });
    },
    onSuccess: async () => {
      await refreshUser();
      setSaved(true);
    },
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
        {t("settings.title")}
      </h1>

      <form onSubmit={handleSave} className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>{t("settings.profile")}</h2>
        <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          {t("settings.email")}
          <input className="input" value={user?.email ?? ""} disabled />
        </label>
        <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          {t("settings.displayName")}
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" style={{ alignSelf: "flex-start" }}>
          {t("settings.saveChanges")}
        </button>
        {saved && (
          <span style={{ color: "var(--color-success)", fontSize: "0.85rem" }}>
            {t("settings.saved")}
          </span>
        )}
      </form>

      <div className="card" style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>{t("settings.appearance")}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{t("common.theme")}</span>
          <ThemeToggle />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{t("settings.language")}</span>
          <LanguageSwitcher />
        </div>
      </div>

      <ZoteroSection />

      <div style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--color-danger)" }}>
          {t("settings.dangerZone")}
        </h2>
        <button
          className="btn btn-secondary"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
          onClick={() => {
            if (confirm(t("settings.deleteAccountConfirm"))) {
              deleteMutation.mutate();
            }
          }}
        >
          {t("settings.deleteAccount")}
        </button>
      </div>
    </div>
  );
}

function ZoteroSection() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");

  const { data: status } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["zotero-status"] });

  const connectMutation = useMutation({
    mutationFn: () => zotero.setCredentials(apiKey.trim()),
    onSuccess: () => {
      setApiKey("");
      invalidate();
    },
    onError: () => toast(t("zotero.invalidKey"), "error"),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => zotero.deleteCredentials(),
    onSuccess: invalidate,
  });

  return (
    <div
      className="card"
      style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}
      data-testid="zotero-section"
    >
      <h2 style={{ fontSize: "1rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BookUp size={16} /> {t("zotero.title")}
      </h2>
      <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
        {t("zotero.description")}
      </p>

      {status?.connected ? (
        <>
          <p style={{ fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <CheckCircle2 size={15} style={{ color: "var(--color-success)" }} />
            {t("zotero.connectedAs", { id: status.zotero_user_id })}
            <code style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
              {status.api_key_masked}
            </code>
          </p>
          <button
            className="btn btn-secondary"
            style={{ alignSelf: "flex-start" }}
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {t("zotero.disconnect")}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (apiKey.trim()) connectMutation.mutate();
          }}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>
            {t("zotero.apiKeyLabel")}
            <input
              className="input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)" }}>
            {t("zotero.apiKeyHint")}{" "}
            <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener noreferrer">
              zotero.org/settings/keys
            </a>
          </p>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ alignSelf: "flex-start" }}
            disabled={!apiKey.trim() || connectMutation.isPending}
          >
            {t("zotero.connect")}
          </button>
        </form>
      )}
    </div>
  );
}
