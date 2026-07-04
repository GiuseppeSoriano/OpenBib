import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";

const LANGS = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
] as const;

export default function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage ?? "en";

  return (
    <label className={`language-switcher ${className ?? ""}`} title={t("common.language")}>
      <Languages size={16} aria-hidden="true" />
      <select
        className="language-select"
        value={current}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        aria-label={t("common.language")}
        data-testid="language-switcher"
      >
        {LANGS.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </label>
  );
}
