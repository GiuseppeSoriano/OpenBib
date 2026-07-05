import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import ThemeSegment from "@/components/ui/ThemeSegment";
import LanguageSegment from "@/components/ui/LanguageSegment";
import ConfirmModal from "@/components/ConfirmModal";
import { useToast } from "@/components/ui/Toast";
import { BookUp, CheckCircle2 } from "lucide-react";
import api, { zotero } from "@/lib/api";
import "./SettingsPage.css";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user, logout, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    <div className="settings">
      <h1>{t("settings.title")}</h1>

      <form onSubmit={handleSave} className="card settings-section">
        <h2>{t("settings.profile")}</h2>
        <label className="settings-field">
          {t("settings.email")}
          <input className="input" value={user?.email ?? ""} disabled />
        </label>
        <label className="settings-field">
          {t("settings.displayName")}
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <div className="settings-row">
          <button type="submit" className="btn btn-primary" disabled={updateMutation.isPending}>
            {t("settings.saveChanges")}
          </button>
          {saved && <span className="settings-saved">{t("settings.saved")}</span>}
        </div>
      </form>

      <div className="card settings-section">
        <h2>{t("settings.appearance")}</h2>
        <div className="settings-row">
          <span className="settings-label">{t("common.theme")}</span>
          <ThemeSegment />
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("settings.language")}</span>
          <LanguageSegment />
        </div>
      </div>

      <ZoteroSection />

      <div className="card settings-section settings-danger">
        <h2>{t("settings.dangerZone")}</h2>
        <button className="btn btn-secondary settings-danger-btn" onClick={() => setConfirmDelete(true)}>
          {t("settings.deleteAccount")}
        </button>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title={t("settings.deleteAccount")}
          message={t("settings.deleteAccountConfirm")}
          confirmLabel={t("common.delete")}
          onConfirm={() => {
            setConfirmDelete(false);
            deleteMutation.mutate();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
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
    <div className="card settings-section" data-testid="zotero-section">
      <h2>
        <BookUp size={15} /> {t("zotero.title")}
      </h2>
      <p className="settings-hint">{t("zotero.description")}</p>

      {status?.connected ? (
        <>
          <p className="settings-zotero-status">
            <CheckCircle2 size={15} />
            {t("zotero.connectedAs", { id: status.zotero_user_id })}
            <code>{status.api_key_masked}</code>
          </p>
          <button
            className="btn btn-secondary settings-self-start"
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
          className="settings-zotero-form"
        >
          <label className="settings-field">
            {t("zotero.apiKeyLabel")}
            <input
              className="input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <p className="settings-hint">
            {t("zotero.apiKeyHint")}{" "}
            <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener noreferrer">
              zotero.org/settings/keys
            </a>
          </p>
          <button
            type="submit"
            className="btn btn-primary settings-self-start"
            disabled={!apiKey.trim() || connectMutation.isPending}
          >
            {t("zotero.connect")}
          </button>
        </form>
      )}
    </div>
  );
}
