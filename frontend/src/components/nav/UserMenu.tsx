import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, LogOut, Settings } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import { useToast } from "@/components/ui/Toast";
import Menu from "@/components/ui/Menu";

const THEMES: { value: ThemePreference; labelKey: string }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" },
];

const LANGS = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
] as const;

interface UserMenuProps {
  /** "avatar": the phone top bar; "sidebar": the account button at the sidebar's foot. */
  variant?: "avatar" | "sidebar";
  /** Sidebar icon rail: the button keeps only the avatar. */
  rail?: boolean;
}

/** Account button opening the user menu: settings, theme, language and logout. */
export default function UserMenu({ variant = "avatar", rail = false }: UserMenuProps) {
  const { t, i18n } = useTranslation();
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();
  const { toast } = useToast();

  if (!user) return null;

  const name = user.display_name ?? user.email;
  const initial = name.charAt(0).toUpperCase();
  const language = i18n.resolvedLanguage ?? "en";
  const inSidebar = variant === "sidebar";

  const button = inSidebar ? (
    <>
      <span className="user-avatar">{initial}</span>
      {!rail && (
        <span className="sidebar-account-text">
          <span className="sidebar-account-name">{name}</span>
          {user.display_name && <span className="sidebar-account-email">{user.email}</span>}
        </span>
      )}
    </>
  ) : (
    <span className="user-avatar">{initial}</span>
  );

  return (
    <Menu
      align={inSidebar ? "left" : "right"}
      side={inSidebar ? "top" : "bottom"}
      button={button}
      buttonClassName={inSidebar ? `sidebar-account${rail ? " sidebar-account--rail" : ""}` : "user-menu-btn"}
      buttonAriaLabel={name}
      buttonTitle={inSidebar && rail ? name : undefined}
      testId="user-menu"
    >
      {(close) => (
        <>
          <div className="menu-header">
            <span className="menu-header-name">{name}</span>
            <span className="menu-header-email">{user.email}</span>
          </div>
          <div className="menu-separator" />
          <Link to="/settings" role="menuitem" className="menu-item" onClick={close}>
            <Settings size={15} />
            {t("nav.settings")}
          </Link>
          <div className="menu-separator" />
          <div role="group" aria-label={t("common.theme")}>
            <div className="menu-group-label label-caps" aria-hidden="true">{t("common.theme")}</div>
            {THEMES.map(({ value, labelKey }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={preference === value}
                className="menu-item"
                onClick={() => {
                  setPreference(value);
                  close();
                }}
              >
                <span className="menu-item-check">{preference === value && <Check size={14} />}</span>
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t("common.language")}>
            <div className="menu-group-label label-caps" aria-hidden="true">{t("common.language")}</div>
            {LANGS.map((lang) => (
              <button
                key={lang.code}
                type="button"
                role="menuitemradio"
                aria-checked={language === lang.code}
                lang={lang.code}
                className="menu-item"
                onClick={() => {
                  void i18n.changeLanguage(lang.code);
                  close();
                }}
              >
                <span className="menu-item-check">{language === lang.code && <Check size={14} />}</span>
                {lang.label}
              </button>
            ))}
          </div>
          <div className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item--danger"
            onClick={async () => {
              close();
              try { await logout(); navigate("/"); } catch { toast(t("auth.logoutFailed"), "error"); }
            }}
          >
            <LogOut size={15} />
            {t("nav.logout")}
          </button>
        </>
      )}
    </Menu>
  );
}
