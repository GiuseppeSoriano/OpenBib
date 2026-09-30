import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookUp, CheckCircle2, ExternalLink } from "lucide-react";
import { zotero } from "@/lib/api";
import { apiErrorText } from "@/lib/apiError";
import { useHashFocus } from "@/hooks/useHashFocus";
import { useToast } from "@/components/ui/Toast";

/**
 * Zotero connection (`/settings#zotero`). The deep link focuses the API key
 * input, or the section itself once Zotero is connected.
 */
export default function ZoteroSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const headingId = useId();
  const inputId = useId();
  const hintId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");

  const { data: status, isLoading } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
  });
  useHashFocus("zotero", sectionRef, { ready: !isLoading, focus: apiKeyRef });

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
    <section
      id="zotero"
      ref={sectionRef}
      tabIndex={-1}
      className="card settings-section"
      aria-labelledby={headingId}
      data-testid="zotero-section"
    >
      <h2 id={headingId}>
        <BookUp size={15} aria-hidden="true" /> {t("zotero.title")}
      </h2>
      <p className="settings-hint">{t("zotero.description")}</p>
      {status?.connected ? (
        <>
          <p className="settings-zotero-status">
            <CheckCircle2 size={15} aria-hidden="true" />
            {t("zotero.connectedAs", { id: status.zotero_user_id })}
            <code>{status.api_key_masked}</code>
          </p>
          <button
            type="button"
            className="btn btn-secondary settings-self-start"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            {t("zotero.disconnect")}
          </button>
        </>
      ) : (
        <form onSubmit={submit} className="settings-zotero-form">
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
    </section>
  );
}
