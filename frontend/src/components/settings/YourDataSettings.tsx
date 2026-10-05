import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import api from "@/lib/api";
import { apiErrorText } from "@/lib/apiError";
import { useLegalConfig } from "@/lib/legal";
import { useToast } from "@/components/ui/Toast";
import SettingsSection, { SettingsRow } from "./SettingsSection";

/**
 * Data export (`/settings#your-data`, the target of the Dashboard, Library
 * and legal-page export links). Warns when this instance keeps no backups.
 */
export default function YourDataSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const helpId = useId();
  const [password, setPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const { data: legal, isLoading } = useLegalConfig();

  async function downloadExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || exporting) return;
    setExporting(true);
    try {
      const response = await api.post("/users/me/export", { password }, { responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `openbib-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(apiErrorText(err, t, t("settings.actionFailed")), "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <SettingsSection id="your-data" title={t("settings.yourData")} describedBy={helpId} ready={!isLoading}>
      {legal?.backups_enabled === false && (
        <p className="settings-notice">
          {t("settings.noBackupsNotice")} <Link to="/privacy">{t("settings.privacyLink")}</Link>
        </p>
      )}
      <SettingsRow
        label={t("settings.exportLabel")}
        description={t("settings.exportHelp")}
        descriptionId={helpId}
      >
        <form className="settings-form" onSubmit={(event) => void downloadExport(event)}>
          <label className="settings-field">
            {t("settings.passwordToConfirm")}
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn btn-secondary settings-self-start"
            disabled={!password || exporting}
            aria-busy={exporting || undefined}
          >
            <Download size={14} aria-hidden="true" />
            {t("settings.exportData")}
          </button>
        </form>
      </SettingsRow>
    </SettingsSection>
  );
}
