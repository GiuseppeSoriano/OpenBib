import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PHONE_QUERY, RAIL_QUERY } from "@/lib/breakpoints";
import { syncRecentSearchesOwner } from "@/lib/recentSearches";
import TopNav from "@/components/nav/TopNav";
import MobileTabBar from "@/components/nav/MobileTabBar";
import Sidebar from "@/components/shell/Sidebar";
import { MobileTopBar, TopBar } from "@/components/shell/TopBar";
import CommandPalette from "@/components/shell/CommandPalette";
import NewCollectionDialog from "@/components/shell/NewCollectionDialog";
import { ShellContext, type ShellChrome, type ShellSlots } from "@/components/shell/ShellContext";
import { useShellShortcuts } from "@/components/shell/shortcuts";
import "@/components/nav/nav.css";
import "@/components/shell/shell.css";

const RAIL_STORAGE_KEY = "openbib.sidebar";
const FULL_CHROME: Required<ShellChrome> = { topBar: true, mobileTopBar: true };

function loadRail(): boolean {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) === "rail";
  } catch {
    return false;
  }
}

function saveRail(rail: boolean) {
  try {
    localStorage.setItem(RAIL_STORAGE_KEY, rail ? "rail" : "full");
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}

function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="app-footer">
      <Link to="/privacy">{t("legal.privacy")}</Link>
      <Link to="/terms">{t("legal.terms")}</Link>
      <a href="https://github.com/GiuseppeSoriano/OpenBib" target="_blank" rel="noopener noreferrer">
        {t("nav.contribute")}
        <ExternalLink size={12} aria-hidden="true" />
        <span className="sr-only">{` ${t("common.opensInNewTab")}`}</span>
      </a>
    </footer>
  );
}

interface LayoutProps {
  /** Full-screen pages (the citation graph): no sidebar, top bar or footer. */
  bare?: boolean;
}

/**
 * App shell. Signed in: a sidebar (an icon rail on tablets) with a slim top
 * bar on wider screens; a top app bar and the bottom tab bar on phones.
 * Visitors get a minimal top bar only. The sidebar never covers the page:
 * the shell reserves its width.
 */
export default function Layout({ bare = false }: LayoutProps) {
  const { user, isLoading } = useAuth();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isTablet = useMediaQuery(RAIL_QUERY);
  const [railChoice, setRailChoice] = useState(loadRail);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [chrome, setChrome] = useState<Required<ShellChrome>>(FULL_CHROME);

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!isLoading) syncRecentSearchesOwner(userId);
  }, [isLoading, userId]);

  useShellShortcuts(paletteOpen, setPaletteOpen);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const newCollection = useCallback(() => setCreating(true), []);
  const toggleRail = useCallback(() => {
    setRailChoice((current) => {
      saveRail(!current);
      return !current;
    });
  }, []);

  const member = !!user;
  const rail = isTablet || railChoice;
  const sidebar = member && !bare && !isPhone;
  const topBar = sidebar && chrome.topBar;
  const mobileTopBar = member && !bare && isPhone && chrome.mobileTopBar;
  const actionsInline = member && !bare && !topBar && !mobileTopBar;

  const setPageChrome = useCallback((next: Required<ShellChrome>) => {
    setChrome((current) => (current.topBar === next.topBar && current.mobileTopBar === next.mobileTopBar ? current : next));
  }, []);
  const slots = useMemo<ShellSlots>(
    () => ({ actionsEl, actionsInline, setChrome: setPageChrome, setTitle, openPalette }),
    [actionsEl, actionsInline, setPageChrome, openPalette],
  );

  let shellClass = "app-shell";
  if (bare) shellClass += " app-shell--bare";
  if (!member) shellClass += " app-shell--anon";
  if (sidebar) shellClass += ` app-shell--sidebar${rail ? " app-shell--rail" : ""}`;
  if (actionsInline) shellClass += " app-shell--no-topbar";

  // One fixed sequence of slots: an absent bar leaves a null in its place, so
  // <main> (and the page in it) is never remounted when the viewport crosses
  // a breakpoint or the session resolves. DOM order on phones stays HEADER,
  // MAIN, FOOTER, NAV (F03).
  return (
    // Full-screen pages keep their actions in place: no slots there.
    <ShellContext.Provider value={bare ? null : slots}>
      <div className={shellClass}>
        {!member && !bare ? <TopNav actionsRef={setActionsEl} pending={isLoading} /> : null}
        {mobileTopBar ? <MobileTopBar actionsRef={setActionsEl} onOpenPalette={openPalette} /> : null}
        {sidebar ? (
          <Sidebar
            rail={rail}
            collapsible={!isTablet}
            onToggleRail={toggleRail}
            onOpenPalette={openPalette}
            onNewCollection={newCollection}
          />
        ) : null}
        {topBar ? <TopBar title={title} actionsRef={setActionsEl} /> : null}
        <main className="app-main">
          <div className="app-container">
            <Outlet />
          </div>
        </main>
        {bare ? null : <Footer />}
        {member && isPhone ? <MobileTabBar /> : null}
      </div>
      {paletteOpen && <CommandPalette onClose={closePalette} onNewCollection={newCollection} />}
      {creating && <NewCollectionDialog onClose={() => setCreating(false)} />}
    </ShellContext.Provider>
  );
}
