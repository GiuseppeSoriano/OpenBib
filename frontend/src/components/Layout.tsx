import { useState } from "react";
import { Outlet, NavLink, Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/ui/Logo";
import ThemeToggle from "@/components/ui/ThemeToggle";
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
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/search", icon: Search, label: "Search" },
  { to: "/collections", icon: FolderOpen, label: "Collections" },
  { to: "/library", icon: BookMarked, label: "Library" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

export default function Layout() {
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
        <ThemeToggle />
      </header>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={closeSidebar} />}

      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar-brand">
          <Logo size={28} className="brand-logo" />
          <span className="brand-text">OpenBib</span>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
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
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-theme">
            <ThemeToggle />
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
                title="Logout"
              >
                <LogOut size={18} />
                <span>Logout</span>
              </button>
            </>
          ) : (
            <NavLink to="/login" className="nav-link" onClick={closeSidebar}>
              <LogIn size={18} />
              <span>Sign in</span>
            </NavLink>
          )}
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>

      {/* Bottom navigation — visible below 640px */}
      <nav className="bottom-nav">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `bottom-nav-link ${isActive ? "bottom-nav-link--active" : ""}`
            }
          >
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
