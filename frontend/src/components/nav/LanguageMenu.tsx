import { useTranslation } from "react-i18next";
import { Check, Languages } from "lucide-react";
import Menu from "@/components/ui/Menu";

const LANGS = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
] as const;

/** Globe menu for switching the UI language — readable in both themes. */
export default function LanguageMenu() {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage ?? "en";

  return (
    <Menu
      align="right"
      button={<Languages size={17} />}
      buttonClassName="btn-ghost topnav-iconbtn"
      buttonAriaLabel={t("common.language")}
      buttonTitle={t("common.language")}
      testId="language-menu"
    >
      {(close) => (
        <>
          {LANGS.map((lang) => (
            <button
              key={lang.code}
              type="button"
              role="menuitemradio"
              aria-checked={current === lang.code}
              className="menu-item"
              onClick={() => {
                void i18n.changeLanguage(lang.code);
                close();
              }}
            >
              <span className="menu-item-check">
                {current === lang.code && <Check size={14} />}
              </span>
              {lang.label}
            </button>
          ))}
        </>
      )}
    </Menu>
  );
}
