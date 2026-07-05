import { useTranslation } from "react-i18next";

const LANGS = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
] as const;

/** Segmented EN|IT control — used on the Settings page. */
export default function LanguageSegment() {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage ?? "en";

  return (
    <div className="segmented" role="group" aria-label={t("common.language")} data-testid="language-segment">
      {LANGS.map((lang) => (
        <button
          key={lang.code}
          type="button"
          className={current === lang.code ? "active" : ""}
          aria-pressed={current === lang.code}
          onClick={() => void i18n.changeLanguage(lang.code)}
        >
          {lang.label}
        </button>
      ))}
    </div>
  );
}
