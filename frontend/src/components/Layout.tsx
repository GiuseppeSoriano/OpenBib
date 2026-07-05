import { Outlet } from "react-router-dom";
import TopNav from "@/components/nav/TopNav";
import MobileTabBar from "@/components/nav/MobileTabBar";

/**
 * App shell: fixed top navbar, content area, bottom tab bar on phones.
 * No sidebars or navigation drawers anywhere.
 */
export default function Layout() {
  return (
    <div className="app-shell">
      <TopNav />
      <main className="app-main">
        <div className="app-container">
          <Outlet />
        </div>
      </main>
      <MobileTabBar />
    </div>
  );
}
