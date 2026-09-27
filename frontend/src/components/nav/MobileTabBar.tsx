import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, FolderOpen, LayoutDashboard, Search } from "lucide-react";

const TABS = [
  { to: "/", icon: LayoutDashboard, labelKey: "nav.dashboard", end: true },
  { to: "/search", icon: Search, labelKey: "nav.search", end: false },
  { to: "/collections", icon: FolderOpen, labelKey: "nav.collections", end: true },
  { to: "/library", icon: BookMarked, labelKey: "nav.library", end: false },
] as const;

/** Bottom tab bar — the primary navigation on phones (<640px). */
export default function MobileTabBar() {
  const { t } = useTranslation();

  return (
    <nav className="tabbar" aria-label={t("nav.primary")}>
      {TABS.map(({ to, icon: Icon, labelKey, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => `tabbar-link ${isActive ? "tabbar-link--active" : ""}`}
        >
          <Icon size={20} />
          <span>{t(labelKey)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
