import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { zotero } from "@/lib/api";
import { LANGUAGES, THEME_OPTIONS, currentLanguage } from "./AppearanceSettings";

export type SettingsSectionId =
  | "profile"
  | "security"
  | "appearance"
  | "language"
  | "zotero"
  | "your-data"
  | "delete-account";

export interface SettingsIndexItem {
  id: SettingsSectionId;
  labelKey: string;
  danger?: boolean;
}

/**
 * The sections in page order. On phones Language is its own drill-in entry;
 * on wider screens it is a row of Appearance (`#language` still lands there).
 * Before accepting updated terms, Integrations is not available.
 */
export function settingsSections(restricted: boolean, phone: boolean): SettingsIndexItem[] {
  const items: (SettingsIndexItem | false)[] = [
    { id: "profile", labelKey: "settings.profile" },
    { id: "security", labelKey: "settings.security" },
    { id: "appearance", labelKey: "settings.appearance" },
    phone && { id: "language", labelKey: "settings.language" },
    !restricted && { id: "zotero", labelKey: "settings.integrations" },
    { id: "your-data", labelKey: "settings.yourData" },
    { id: "delete-account", labelKey: "settings.deleteAccount", danger: true },
  ];
  return items.filter((item): item is SettingsIndexItem => !!item);
}

/** Desktop and tablet: the section index beside the content, current one marked. */
export function SettingsNav({ items, active }: { items: SettingsIndexItem[]; active: string }) {
  const { t } = useTranslation();
  return (
    <nav className="settings-index" aria-label={t("settings.sectionsLabel")}>
      <ul className="settings-index-list">
        {items.map(({ id, labelKey, danger }) => (
          <li key={id}>
            <Link
              to={`#${id}`}
              replace
              className={danger ? "settings-index-link settings-index-link--danger" : "settings-index-link"}
              aria-current={active === id ? "true" : undefined}
            >
              {t(labelKey)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface MobileIndexProps {
  items: SettingsIndexItem[];
  restricted: boolean;
  /** Section the reader came back from: its entry takes focus again. */
  returnFocus: string | null;
}

/** Phones: the account summary and a drill-in list, each entry opening one section. */
export function SettingsMobileIndex({ items, restricted, returnFocus }: MobileIndexProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { preference } = useTheme();
  const links = useRef<Partial<Record<string, HTMLAnchorElement | null>>>({});
  const [focusOnMount] = useState(returnFocus);
  const { data: zoteroStatus } = useQuery({
    queryKey: ["zotero-status"],
    queryFn: () => zotero.getStatus(),
    enabled: !restricted,
  });

  useEffect(() => {
    if (focusOnMount) links.current[focusOnMount]?.focus();
  }, [focusOnMount]);

  const theme = THEME_OPTIONS.find((option) => option.value === preference);
  const language = currentLanguage(i18n.resolvedLanguage);
  const hints: Partial<Record<SettingsSectionId, string>> = {
    appearance: theme ? t(theme.labelKey) : undefined,
    language: LANGUAGES.find((option) => option.value === language)?.label,
    zotero: zoteroStatus ? t(zoteroStatus.connected ? "settings.zoteroOn" : "settings.zoteroOff") : undefined,
    "your-data": t("settings.exportHint"),
  };
  const name = user?.display_name ?? user?.email ?? "";

  return (
    <>
      {user && (
        <div className="settings-account">
          <span className="settings-avatar" aria-hidden="true">
            {name.charAt(0).toUpperCase()}
          </span>
          <div className="settings-account-text">
            <p className="settings-account-name">{name}</p>
            <p className="settings-account-email">
              {user.email}
              {user.email_verified && (
                <span className="settings-verified">
                  <CheckCircle2 size={13} aria-hidden="true" />
                  {t("settings.emailVerified")}
                </span>
              )}
            </p>
          </div>
        </div>
      )}
      <nav className="settings-drill" aria-label={t("settings.sectionsLabel")}>
        <ul className="settings-drill-list">
          {items.map(({ id, labelKey, danger }) => (
            <li key={id}>
              <Link
                to={`#${id}`}
                state={{ settingsIndex: true }}
                ref={(element) => {
                  links.current[id] = element;
                }}
                className={danger ? "settings-drill-item settings-drill-item--danger" : "settings-drill-item"}
              >
                <span className="settings-drill-label">{t(labelKey)}</span>
                {hints[id] && <span className="settings-drill-hint">{hints[id]}</span>}
                <ChevronRight size={16} aria-hidden="true" className="settings-drill-chevron" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
