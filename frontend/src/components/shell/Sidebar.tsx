import { Link, NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogOut, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings } from "lucide-react";
import Logo from "@/components/ui/Logo";
import UserMenu from "@/components/nav/UserMenu";
import { useSignOut } from "@/components/nav/useSignOut";
import { PRIMARY_NAV, useCollectionsList, useLibraryCount } from "@/components/shell/navItems";
import { shortcutLabel } from "@/components/shell/shortcuts";
import { useRecentSearches } from "@/lib/recentSearches";

// Collections listed before "All collections" takes over.
const SIDEBAR_COLLECTIONS = 8;

interface SidebarProps {
  /** Icon rail: tablets, or a desktop sidebar the user collapsed. */
  rail: boolean;
  /** Desktop only: the user may collapse and expand it. */
  collapsible: boolean;
  onToggleRail: () => void;
  onOpenPalette: () => void;
  onNewCollection: () => void;
}

function navClass({ isActive }: { isActive: boolean }) {
  return `sidebar-link${isActive ? " sidebar-link--active" : ""}`;
}

/** Desktop and tablet navigation: never overlays the page, the shell reserves its width. */
export default function Sidebar({ rail, collapsible, onToggleRail, onOpenPalette, onNewCollection }: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const libraryCount = useLibraryCount(true);
  const { data } = useCollectionsList(!rail);
  const collections = Array.isArray(data) ? data : [];
  const recent = useRecentSearches();
  const { signOut, pending: signingOut } = useSignOut();
  const onSearch = location.pathname === "/search";
  const listed = rail ? [] : collections.slice(0, SIDEBAR_COLLECTIONS);
  // One current page: an open collection listed below takes over from Collections.
  const openId = /^\/collections\/([^/]+)\/?$/.exec(location.pathname)?.[1];
  const openListed = !!openId && listed.some((c) => c.id === openId);

  const label = (text: string) => <span className={rail ? "sr-only" : "sidebar-link-label"}>{text}</span>;
  const count = (value: number) => (
    <>
      <span className="sidebar-count" aria-hidden="true">{value}</span>
      <span className="sr-only">{` (${t("collections.paperCount", { count: value })})`}</span>
    </>
  );

  return (
    <aside className={`sidebar${rail ? " sidebar--rail" : ""}`} aria-label={t("shell.sidebar")}>
      <div className="sidebar-head">
        <Link to="/" className="sidebar-brand">
          <Logo size={22} className="sidebar-logo" />
          {!rail && <span className="sidebar-wordmark" aria-hidden="true">OpenBib</span>}
        </Link>
        {collapsible && (
          <button
            type="button"
            className="sidebar-iconbtn"
            onClick={onToggleRail}
            aria-label={t(rail ? "shell.expandSidebar" : "shell.collapseSidebar")}
            title={t(rail ? "shell.expandSidebar" : "shell.collapseSidebar")}
          >
            {rail ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </button>
        )}
      </div>

      <button
        type="button"
        className="sidebar-search"
        onClick={onOpenPalette}
        aria-keyshortcuts="Meta+K Control+K"
        title={rail ? t("shell.searchOrJump") : undefined}
        data-testid="palette-button"
      >
        <Search size={15} aria-hidden="true" />
        {label(t("shell.searchOrJump"))}
        {!rail && <kbd aria-hidden="true">{shortcutLabel()}</kbd>}
      </button>

      <div className="sidebar-scroll">
        <nav className="sidebar-nav" aria-label={t("nav.primary")}>
          {PRIMARY_NAV.map(({ to, labelKey, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end || (to === "/collections" && openListed)}
              // From a search, Search reopens it without a duplicate history entry.
              replace={(to === "/search" && onSearch) || undefined}
              className={navClass}
              title={rail ? t(labelKey) : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {label(t(labelKey))}
              {to === "/library" && !rail && libraryCount !== undefined && count(libraryCount)}
            </NavLink>
          ))}
        </nav>

        {!rail && (
          <nav className="sidebar-section" aria-label={t("shell.yourCollections")}>
            <div className="sidebar-section-head">
              <span className="label-caps">{t("nav.collections")}</span>
              <button
                type="button"
                className="sidebar-iconbtn"
                onClick={onNewCollection}
                aria-label={t("collections.new")}
                title={t("collections.new")}
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
            {listed.map((c, index) => (
              <NavLink key={c.id} to={`/collections/${c.id}`} className={({ isActive }) => `${navClass({ isActive })} sidebar-link--sub`}>
                <span className={`sidebar-dot sidebar-dot--${c.is_owner ? index % 3 : "shared"}`} aria-hidden="true" />
                <span className="sidebar-link-label">{c.name}</span>
                {count(c.paper_count)}
              </NavLink>
            ))}
            {collections.length > SIDEBAR_COLLECTIONS && (
              <Link to="/collections" className="sidebar-link sidebar-link--sub sidebar-link--more">
                {t("shell.allCollections")}
              </Link>
            )}
          </nav>
        )}

        {!rail && onSearch && recent.length > 0 && (
          <nav className="sidebar-section sidebar-recent" aria-label={t("shell.recentSearches")}>
            <span className="label-caps sidebar-section-label">{t("shell.recentSearches")}</span>
            <ul>
              {recent.map((item) => (
                <li key={item.search}>
                  <Link to={`/search?${item.search}`} className="sidebar-recent-link">
                    <span className="sidebar-recent-text">{item.query}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>

      <div className="sidebar-foot">
        <NavLink to="/settings" className={navClass} title={rail ? t("nav.settings") : undefined}>
          <Settings size={16} aria-hidden="true" />
          {label(t("nav.settings"))}
        </NavLink>
        {/* The one place to sign out on desktop and tablet: the account menu does not repeat it. */}
        <button
          type="button"
          className="sidebar-link sidebar-signout"
          // aria-disabled, not disabled: focus stays here if sign-out fails.
          onClick={() => { if (!signingOut) void signOut(); }}
          aria-disabled={signingOut || undefined}
          aria-busy={signingOut || undefined}
          title={rail ? t("nav.signOut") : undefined}
          data-testid="sidebar-signout"
        >
          <LogOut size={16} aria-hidden="true" />
          {label(t("nav.signOut"))}
        </button>
        <UserMenu variant="sidebar" rail={rail} />
      </div>
    </aside>
  );
}
