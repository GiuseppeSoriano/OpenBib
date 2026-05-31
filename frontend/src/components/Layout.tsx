import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import {
  Search,
  LayoutDashboard,
  FolderOpen,
  BookMarked,
  GitFork,
  Settings,
  LogOut,
} from "lucide-react";
import "./Layout.css";

const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/search", icon: Search, label: "Search" },
  { to: "/collections", icon: FolderOpen, label: "Collections" },
  { to: "/library", icon: BookMarked, label: "Library" },
  { to: "/graph", icon: GitFork, label: "Graph" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">R</span>
          <span className="brand-text">RefMan</span>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
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
          <div className="user-info">
            <span className="user-avatar">
              {(user?.display_name ?? user?.email ?? "U").charAt(0).toUpperCase()}
            </span>
            <span className="user-name">{user?.display_name ?? user?.email}</span>
          </div>
          <button className="btn-ghost nav-link" onClick={handleLogout} title="Logout">
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
