import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookUp, CheckCircle2, ExternalLink } from "lucide-react";
import { zotero } from "@/lib/api";
import { apiErrorText } from "@/lib/apiError";
import { useToast } from "@/components/ui/Toast";
import SettingsSection, { SettingsRow } from "./SettingsSection";

/**
 * Integrations: the Zotero connection (`/settings#zotero`). The deep link
 * focuses the API key input, or the section itself once Zotero is connected.
 */
export default function ZoteroSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputId = useId();
  const hintId = useId();
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");

  const { data: status, isLoading } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["zotero-status"] });
  const connect = useMutation({
    mutationFn: () => zotero.setCredentials(apiKey.trim()),
    onSuccess: () => {
      setApiKey("");
      invalidate();
    },
    onError: (err: unknown) => toast(apiErrorText(err, t, t("zotero.invalidKey")), "error"),
  });
  const disconnect = useMutation({
    mutationFn: () => zotero.deleteCredentials(),
    onSuccess: invalidate,
    onError: (err: unknown) => toast(apiErrorText(err, t, t("settings.actionFailed")), "error"),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (apiKey.trim()) connect.mutate();
  }

  return (
    <SettingsSection
      id="zotero"
      title={t("settings.integrations")}
      ready={!isLoading}
      focus={apiKeyRef}
      testId="zotero-section"
    >
      <SettingsRow
        label={
          <>
            <BookUp size={15} aria-hidden="true" className="settings-row-icon" />
            {t("zotero.title")}
          </>
        }
        description={t("zotero.description")}
      >
        {status?.connected ? (
          <div className="settings-inline">
            <p className="settings-zotero-status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>
                {t("zotero.connectedAs", { id: status.zotero_user_id })}{" "}
                <code>{status.api_key_masked}</code>
              </span>
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {t("zotero.disconnect")}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="settings-form">
            {!isLoading && <p className="settings-status">{t("settings.zoteroNotConnected")}</p>}
            <label className="settings-field" htmlFor={inputId}>
              {t("zotero.apiKeyLabel")}
            </label>
            <input
              id={inputId}
              ref={apiKeyRef}
              className="input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              aria-describedby={hintId}
            />
            <p className="settings-hint" id={hintId}>
              {t("zotero.apiKeyHint")}{" "}
              <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener noreferrer">
                zotero.org/settings/keys
                <ExternalLink size={11} aria-hidden="true" className="settings-external" />
                <span className="sr-only">{` ${t("common.opensInNewTab")}`}</span>
              </a>
            </p>
            <button
              type="submit"
              className="btn btn-primary settings-self-start"
              disabled={!apiKey.trim() || connect.isPending}
            >
              {t("zotero.connect")}
            </button>
          </form>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
