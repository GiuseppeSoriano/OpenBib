import { NavLink, Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogIn, Search } from "lucide-react";
import Logo from "@/components/ui/Logo";
import ThemeToggle from "@/components/ui/ThemeToggle";
import LanguageMenu from "@/components/nav/LanguageMenu";
import "./nav.css";

interface TopNavProps {
  /** Page actions container (see shell/ShellContext). */
  actionsRef?: (el: HTMLDivElement | null) => void;
  /** While the session is being restored: the logo only, no sign-in yet. */
  pending?: boolean;
}

/** Visitors' minimal top bar: logo, Search, theme, language and Sign in. No sidebar. */
export default function TopNav({ actionsRef, pending = false }: TopNavProps) {
  const location = useLocation();
  const { t } = useTranslation();

  return (
    <header className="topnav">
      <Link to="/" className="topnav-brand">
        <Logo size={22} className="topnav-logo" />
        <span className="topnav-wordmark" aria-hidden="true">OpenBib</span>
      </Link>

      <div className="topbar-actions topnav-page-actions" ref={actionsRef} />

      {!pending && (
        <div className="topnav-actions">
          <NavLink
            to="/search"
            // From a search, Search reopens it without a duplicate history entry.
            replace={location.pathname === "/search" || undefined}
            className={({ isActive }) => `btn-ghost topnav-iconbtn topnav-search${isActive ? " topnav-search--active" : ""}`}
          >
            <Search size={15} aria-hidden="true" />
            <span className="topnav-search-label">{t("nav.search")}</span>
          </NavLink>
          <ThemeToggle />
          <LanguageMenu />
          <Link
            to="/login"
            state={{ returnTo: location.pathname + location.search + location.hash }}
            className="btn btn-primary topnav-signin"
          >
            <LogIn size={15} aria-hidden="true" />
            <span className="topnav-signin-label">{t("nav.signIn")}</span>
          </Link>
        </div>
      )}
    </header>
  );
}
