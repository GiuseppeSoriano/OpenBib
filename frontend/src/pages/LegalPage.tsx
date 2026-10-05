import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import QueryError from "@/components/ui/QueryError";
import { inlineValue, localize, useLegalConfig, type LegalText } from "@/lib/legal";
import "./LegalPage.css";

// Role identifiers are compared without case or separators ("sub-processor" == "subprocessor").
const ROLE_KEYS = new Map([
  ["processor", "processor"],
  ["controller", "controller"],
  ["independentcontroller", "independentController"],
  ["jointcontroller", "jointController"],
  ["subprocessor", "subProcessor"],
]);

export default function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation();
  const { data, isLoading, error, refetch, isFetching } = useLegalConfig();
  if (isLoading) return <div className="legal-page legal-status" role="status">{t("legal.page.loading")}</div>;
  if (error || !data) {
    return (
      <div className="legal-page legal-status">
        <QueryError message={t("legal.page.unavailable")} onRetry={() => void refetch()} busy={isFetching} />
      </div>
    );
  }

  const text = (value: LegalText | null | undefined) => inlineValue(localize(value, i18n.resolvedLanguage));
  const role = (value: LegalText) => {
    const key = typeof value === "string" ? ROLE_KEYS.get(value.toLowerCase().replace(/[^a-z]/g, "")) : undefined;
    return key ? t(`legal.roles.${key}`) : text(value);
  };
  const backupsEnabled = data.backups_enabled ?? true;
  const journalEnabled = data.deletion_journal_enabled ?? backupsEnabled;
  const operatorIdentity = [data.operator.name, data.operator.address?.trim(), text(data.operator.country)]
    .filter(Boolean)
    .join(", ");
  const exportLink = { exportLink: <Link to="/settings#your-data" /> };
  const header = (title: string, version: string) => (
    <header className="legal-header">
      <p className="legal-eyebrow">{t("legal.page.eyebrow")}</p>
      <h1 className="legal-title">{title}</h1>
      <p className="legal-version">{t("legal.page.version", { version, date: data.effective_date })}</p>
    </header>
  );

  if (kind === "terms") {
    return (
      <article className="legal-page">
        {header(t("legal.page.termsTitle"), data.terms_version)}
        <h2>{t("legal.page.operatorHeading")}</h2>
        <p>
          {operatorIdentity}. <a href={`mailto:${data.operator.support_email}`}>{data.operator.support_email}</a>
        </p>
        <h2>{t("legal.page.acceptableUseHeading")}</h2>
        <p>{t("legal.page.acceptableUse", { age: data.minimum_age })}</p>
        <h2>{t("legal.page.accountsHeading")}</h2>
        <p>{t("legal.page.accounts")}</p>
        <h2>{t("legal.page.availabilityHeading")}</h2>
        <p>
          <Trans i18nKey="legal.page.availability" components={exportLink} />
        </p>
        <p className="legal-crosslink">
          <Link to="/privacy">{t("legal.page.readPrivacy")}</Link>
        </p>
      </article>
    );
  }

  return (
    <article className="legal-page">
      {header(t("legal.page.privacyTitle"), data.privacy_version)}
      <h2>{t("legal.page.controllerHeading")}</h2>
      <p>
        {operatorIdentity}. <a href={`mailto:${data.operator.privacy_email}`}>{data.operator.privacy_email}</a>
      </p>
      <h2>{t("legal.page.dataHeading")}</h2>
      <p>{t("legal.page.data")}</p>
      <h2>{t("legal.page.providersHeading")}</h2>
      <p>{t("legal.page.providers")}</p>
      <ul className="legal-providers">
        {data.third_parties.map((party) => {
          const safeguard = text(party.transfer_safeguard);
          const details = { purpose: text(party.purpose), role: role(party.role), region: text(party.region), safeguard };
          return (
            <li key={party.name}>
              <a className="legal-provider-link" href={party.privacy_url} target="_blank" rel="noopener noreferrer">
                {party.name}
                <ExternalLink size={12} aria-hidden="true" />
                <span className="sr-only">{` ${t("common.opensInNewTab")}`}</span>
              </a>
              {t(safeguard ? "legal.page.providerDetailsSafeguard" : "legal.page.providerDetails", details)}
            </li>
          );
        })}
      </ul>
      <h2>{t("legal.page.retentionHeading")}</h2>
      <p>
        {t("legal.page.retention", {
          accessDays: data.retention.access_logs_days,
          securityDays: data.retention.security_events_days,
        })}
      </p>
      <p>
        {backupsEnabled ? (
          t("legal.page.backupsEnabled", { days: data.retention.backups_days })
        ) : (
          <Trans i18nKey="legal.page.backupsDisabled" components={exportLink} />
        )}
      </p>
      {journalEnabled && <p>{t("legal.page.journal")}</p>}
      <p>{t("legal.page.registration")}</p>
      <p>{t("legal.page.storage")}</p>
      <h2>{t("legal.page.rightsHeading")}</h2>
      <p>{t("legal.page.rights")}</p>
      <p>{t("legal.page.hosting", { location: text(data.data_location) })}</p>
      <p className="legal-crosslink">
        <Link to="/terms">{t("legal.page.readTerms")}</Link>
      </p>
    </article>
  );
}
