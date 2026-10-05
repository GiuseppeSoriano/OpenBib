import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import api from "@/lib/api";
import SettingsSection, { SettingsRow } from "./SettingsSection";

/** Profile (`#profile`): display name and the sign-in email. */
export default function ProfileSettings() {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();
  const inputId = useId();
  const helpId = useId();
  const saved = user?.display_name ?? "";
  const [displayName, setDisplayName] = useState(saved);
  useEffect(() => {
    setDisplayName(saved);
  }, [saved]);

  const profile = useMutation({
    mutationFn: () => api.patch("/users/me", { display_name: displayName }),
    onSuccess: async () => {
      await refreshUser();
      toast(t("settings.saved"), "success");
    },
    onError: () => toast(t("settings.actionFailed"), "error"),
  });
  const dirty = displayName !== saved;

  return (
    <SettingsSection id="profile" title={t("settings.profile")}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          profile.mutate();
        }}
      >
        <SettingsRow
          label={t("settings.displayName")}
          labelFor={inputId}
          description={t("settings.displayNameHelp")}
          descriptionId={helpId}
        >
          <input
            id={inputId}
            className="input"
            minLength={1}
            maxLength={100}
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-describedby={helpId}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.email")} description={t("settings.emailHelp")}>
          <p className="settings-value">
            <span className="settings-email">{user?.email}</span>
            {user?.email_verified && (
              <span className="settings-verified">
                <CheckCircle2 size={13} aria-hidden="true" />
                {t("settings.emailVerified")}
              </span>
            )}
          </p>
        </SettingsRow>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setDisplayName(saved)}
            disabled={!dirty || profile.isPending}
          >
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={profile.isPending}>
            {t("settings.saveProfile")}
          </button>
        </div>
      </form>
    </SettingsSection>
  );
}

/** Before accepting updated terms, the profile is replaced by this notice. */
export function RestrictedProfileNotice() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="profile" title={t("settings.profile")}>
      <div className="settings-notice">
        <p>{t("auth.accountAccessWithoutAcceptance")}</p>
        <Link to="/legal-review">{t("auth.legalReview")}</Link>
      </div>
    </SettingsSection>
  );
}
