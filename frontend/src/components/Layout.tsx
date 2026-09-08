import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import TopNav from "@/components/nav/TopNav";
import MobileTabBar from "@/components/nav/MobileTabBar";

/**
 * App shell: fixed top navbar, content area, bottom tab bar on phones.
 * No sidebars or navigation drawers anywhere.
 */
export default function Layout() {
  const { t } = useTranslation();
  return (
    <div className="app-shell">
      <TopNav />
      <main className="app-main">
        <div className="app-container">
          <Outlet />
        </div>
      </main>
      <footer className="app-footer"><Link to="/privacy">{t("legal.privacy")}</Link><Link to="/terms">{t("legal.terms")}</Link></footer>
      <MobileTabBar />
    </div>
  );
}
