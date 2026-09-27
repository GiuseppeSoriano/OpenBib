import { NavLink, Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogIn } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/ui/Logo";
import ThemeToggle from "@/components/ui/ThemeToggle";
import UserMenu from "@/components/nav/UserMenu";
import LanguageMenu from "@/components/nav/LanguageMenu";
import "./nav.css";

const NAV_ITEMS = [
  { to: "/", labelKey: "nav.dashboard", end: true },
  { to: "/search", labelKey: "nav.search", end: false },
  { to: "/collections", labelKey: "nav.collections", end: true },
  { to: "/library", labelKey: "nav.library", end: false },
] as const;

/** Slim top navigation bar — the app's only navigation chrome on desktop. */
export default function TopNav() {
  const location = useLocation();
  const { t } = useTranslation();
  const { user } = useAuth();

  return (
    <header className="topnav">
      <Link to="/" className="topnav-brand">
        <Logo size={22} className="topnav-logo" />
        <span className="topnav-wordmark">OpenBib</span>
      </Link>

      <nav className="topnav-links" aria-label="Primary">
        {NAV_ITEMS.map(({ to, labelKey, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `topnav-link ${isActive ? "topnav-link--active" : ""}`
            }
          >
            {t(labelKey)}
          </NavLink>
        ))}
      </nav>

      <div className="topnav-actions">
        <ThemeToggle />
        <LanguageMenu />
        {user ? (
          <UserMenu />
        ) : (
          <Link to="/login" state={{ returnTo: location.pathname + location.hash }} className="btn btn-primary topnav-signin">
            <LogIn size={14} />
            {t("nav.signIn")}
          </Link>
        )}
      </div>
    </header>
  );
}
