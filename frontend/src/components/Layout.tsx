import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
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
      <footer className="app-footer">
        <Link to="/privacy">{t("legal.privacy")}</Link>
        <Link to="/terms">{t("legal.terms")}</Link>
        <a href="https://github.com/GiuseppeSoriano/OpenBib" target="_blank" rel="noopener noreferrer">
          {t("nav.contribute")}
          <ExternalLink size={12} aria-hidden="true" />
          <span className="sr-only">{` ${t("common.opensInNewTab")}`}</span>
        </a>
      </footer>
      <MobileTabBar />
    </div>
  );
}
