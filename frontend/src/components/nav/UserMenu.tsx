import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogOut, Settings } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import Menu from "@/components/ui/Menu";

/** Avatar button opening the account menu (settings, logout). */
export default function UserMenu() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  if (!user) return null;

  const name = user.display_name ?? user.email;
  const initial = name.charAt(0).toUpperCase();

  return (
    <Menu
      align="right"
      button={<span className="user-avatar">{initial}</span>}
      buttonClassName="user-menu-btn"
      buttonAriaLabel={name}
      testId="user-menu"
    >
      {(close) => (
        <>
          <div className="menu-header">
            <span className="menu-header-name">{name}</span>
            <span className="menu-header-email">{user.email}</span>
          </div>
          <div className="menu-separator" />
          <Link
            to="/settings"
            role="menuitem"
            className="menu-item"
            onClick={close}
          >
            <Settings size={15} />
            {t("nav.settings")}
          </Link>
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
