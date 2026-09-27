import { useTranslation } from "react-i18next";

export default function QueryError({ onRetry, busy = false, message }: { onRetry: () => void; busy?: boolean; message?: string }) {
  const { t } = useTranslation();
  return <div className="query-feedback" role="alert">
    <span>{message ?? t("common.loadFailed")}</span>
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRetry}>{t("common.retry")}</button>
  </div>;
}
