import { useId, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import api from "@/lib/api";
import { changeSession } from "@/lib/session";
import SettingsSection, { SettingsRow } from "./SettingsSection";

// Its own password input: typing one to export data never arms account deletion.
export default function DeleteAccountSettings() {
  const { t } = useTranslation();
  const { clearSession } = useAuth();
  const { toast } = useToast();
  const helpId = useId();
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
    <SettingsSection id="delete-account" title={t("settings.deleteAccount")} danger>
      <SettingsRow
        label={t("settings.deleteAccountLabel")}
        description={t("settings.deleteAccountHelp")}
        descriptionId={helpId}
      >
        <form
          className="settings-form"
          aria-describedby={helpId}
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
      </SettingsRow>
    </SettingsSection>
  );
}
