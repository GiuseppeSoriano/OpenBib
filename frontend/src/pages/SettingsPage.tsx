import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import ThemeSegment from "@/components/ui/ThemeSegment";
import LanguageSegment from "@/components/ui/LanguageSegment";
import api from "@/lib/api";
import { changeSession } from "@/lib/session";
import SecuritySettings from "@/components/settings/SecuritySettings";
import ZoteroSettings from "@/components/settings/ZoteroSettings";
import YourDataSettings from "@/components/settings/YourDataSettings";
import "./SettingsPage.css";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Before accepting updated terms, only the account tools stay available.
  const restricted = !!user?.legal_acceptance_required;

  return (
    <div className="settings">
      <h1>{t("settings.title")}</h1>
      {restricted ? (
        <div className="card settings-section">
          <p>{t("auth.accountAccessWithoutAcceptance")}</p>
          <Link to="/legal-review">{t("auth.legalReview")}</Link>
        </div>
      ) : (
        <ProfileSettings />
      )}
      <SecuritySettings />
      <section className="card settings-section" aria-labelledby="settings-appearance">
        <h2 id="settings-appearance">{t("settings.appearance")}</h2>
        <div className="settings-row">
          <span className="settings-label">{t("common.theme")}</span>
          <ThemeSegment />
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("settings.language")}</span>
          <LanguageSegment />
        </div>
      </section>
      {!restricted && <ZoteroSettings />}
      <YourDataSettings />
      <DangerZone />
    </div>
  );
}

function ProfileSettings() {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();
  const headingId = useId();
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  useEffect(() => {
    setDisplayName(user?.display_name ?? "");
  }, [user?.display_name]);

  const profile = useMutation({
    mutationFn: () => api.patch("/users/me", { display_name: displayName }),
    onSuccess: async () => {
      await refreshUser();
      toast(t("settings.saved"), "success");
    },
    onError: () => toast(t("settings.actionFailed"), "error"),
  });

  return (
    <form
      className="card settings-section"
      aria-labelledby={headingId}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        profile.mutate();
      }}
    >
      <h2 id={headingId}>{t("settings.profile")}</h2>
      <label className="settings-field">
        {t("settings.email")}
        <input className="input" value={user?.email ?? ""} disabled />
      </label>
      <label className="settings-field">
        {t("settings.displayName")}
        <input
          className="input"
          minLength={1}
          maxLength={100}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary settings-self-start" disabled={profile.isPending}>
        {t("settings.saveChanges")}
      </button>
    </form>
  );
}

// Its own password input: typing one to export data never arms account deletion.
function DangerZone() {
  const { t } = useTranslation();
  const { clearSession } = useAuth();
  const { toast } = useToast();
  const headingId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const remove = useMutation({
    mutationFn: () =>
      changeSession(
        () => api.post("/users/me/delete", { password, confirmation }),
        clearSession,
      ),
    onError: () => toast(t("settings.actionFailed"), "error"),
  });

  return (
    <section className="card settings-section settings-danger" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("settings.dangerZone")}</h2>
      <p className="settings-hint">{t("settings.deleteAccountHelp")}</p>
      <form
        className="settings-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (password && confirmation === "DELETE") remove.mutate();
        }}
      >
        <label className="settings-field">
          {t("settings.deletePassword")}
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="settings-field">
          {t("settings.typeDelete")}
          <input
            className="input"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          type="submit"
          className="btn btn-secondary settings-danger-btn"
          disabled={!password || confirmation !== "DELETE" || remove.isPending}
        >
          {t("settings.deleteAccount")}
        </button>
      </form>
    </section>
  );
}
