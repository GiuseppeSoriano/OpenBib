import { useState } from "react";
import { Outlet, NavLink, Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/ui/Logo";
import ThemeToggle from "@/components/ui/ThemeToggle";
import LanguageSwitcher from "@/components/ui/LanguageSwitcher";
import {
  Search,
  LayoutDashboard,
  FolderOpen,
  BookMarked,
  Settings,
  LogOut,
  LogIn,
  Menu,
  X,
} from "lucide-react";
import "./Layout.css";

const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, labelKey: "nav.dashboard" },
  { to: "/search", icon: Search, labelKey: "nav.search" },
  { to: "/collections", icon: FolderOpen, labelKey: "nav.collections" },
  { to: "/library", icon: BookMarked, labelKey: "nav.library" },
  { to: "/settings", icon: Settings, labelKey: "nav.settings" },
] as const;

export default function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="layout">
      {/* Top bar — visible below 1024px */}
      <header className="topbar">
        <button
          type="button"
          className="btn-ghost topbar-menu"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Toggle menu"
          aria-expanded={sidebarOpen}
        >
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <Link to="/" className="topbar-brand" onClick={closeSidebar}>
          <Logo size={24} className="brand-logo" />
          <span className="brand-text">OpenBib</span>
        </Link>
        <LanguageSwitcher />
        <ThemeToggle />
      </header>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={closeSidebar} />}

      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar-brand">
          <Logo size={28} className="brand-logo" />
          <span className="brand-text">OpenBib</span>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ to, icon: Icon, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={closeSidebar}
              className={({ isActive }) =>
                `nav-link ${isActive ? "nav-link--active" : ""}`
              }
            >
              <Icon size={18} />
              <span>{t(labelKey)}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-theme">
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
          {user ? (
            <>
              <div className="user-info">
                <span className="user-avatar">
                  {(user.display_name ?? user.email).charAt(0).toUpperCase()}
                </span>
                <span className="user-name">{user.display_name ?? user.email}</span>
              </div>
              <button
                type="button"
                className="btn-ghost nav-link"
                onClick={handleLogout}
                title={t("nav.logout")}
              >
                <LogOut size={18} />
                <span>{t("nav.logout")}</span>
              </button>
            </>
          ) : (
            <NavLink to="/login" className="nav-link" onClick={closeSidebar}>
              <LogIn size={18} />
              <span>{t("nav.signIn")}</span>
            </NavLink>
          )}
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>

      {/* Bottom navigation — visible below 640px */}
      <nav className="bottom-nav">
        {NAV_ITEMS.map(({ to, icon: Icon, labelKey }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `bottom-nav-link ${isActive ? "bottom-nav-link--active" : ""}`
            }
          >
            <Icon size={20} />
            <span>{t(labelKey)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
