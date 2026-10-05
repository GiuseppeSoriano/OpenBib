import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import Logo from "@/components/ui/Logo";
import UserMenu from "@/components/nav/UserMenu";

// Route names for the breadcrumb; deeper pages name themselves (useTopBarTitle).
const ROUTE_LABEL_KEYS: Record<string, string> = {
  "/": "nav.dashboard",
  "/search": "nav.search",
  "/library": "nav.library",
  "/collections": "nav.collections",
  "/settings": "nav.settings",
  "/privacy": "legal.privacy",
  "/terms": "legal.terms",
};

interface Crumb {
  label: string;
  to?: string;
}

function useCrumbs(title: string | null): Crumb[] {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const key = ROUTE_LABEL_KEYS[path];
  if (key) return [{ label: title ?? t(key) }];
  if (path.startsWith("/collections/")) {
    const parent = { label: t("nav.collections"), to: "/collections" };
    return title ? [parent, { label: title }] : [parent];
  }
  return title ? [{ label: title }] : [];
}

interface TopBarProps {
  title: string | null;
  actionsRef: (el: HTMLDivElement | null) => void;
}

/** Desktop and tablet: the page's place in the app on the left, its actions on the right. */
export function TopBar({ title, actionsRef }: TopBarProps) {
  const { t } = useTranslation();
  const crumbs = useCrumbs(title);

  return (
    <header className="topbar">
      <nav className="breadcrumb" aria-label={t("shell.breadcrumb")}>
        <ol>
          <li className="breadcrumb-root">{t("shell.workspace")}</li>
          {crumbs.map((crumb, index) => (
            <li key={`${index}-${crumb.label}`}>
              {crumb.to ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>{crumb.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="topbar-actions" ref={actionsRef} />
    </header>
  );
}

interface MobileTopBarProps {
  actionsRef: (el: HTMLDivElement | null) => void;
  onOpenPalette: () => void;
}

/** Phones: logo, page actions, search (the command palette) and the account menu. */
export function MobileTopBar({ actionsRef, onOpenPalette }: MobileTopBarProps) {
  const { t } = useTranslation();
  return (
    <header className="topbar topbar--mobile">
      <Link to="/" className="topbar-brand">
        <Logo size={20} className="topbar-logo" />
        <span className="topbar-wordmark" aria-hidden="true">OpenBib</span>
      </Link>
      <div className="topbar-actions" ref={actionsRef} />
      <button
        type="button"
        className="btn-ghost topbar-iconbtn"
        onClick={onOpenPalette}
        aria-label={t("shell.searchOrJump")}
        title={t("shell.searchOrJump")}
        data-testid="palette-button"
      >
        <Search size={20} aria-hidden="true" />
      </button>
      <UserMenu />
    </header>
  );
}
