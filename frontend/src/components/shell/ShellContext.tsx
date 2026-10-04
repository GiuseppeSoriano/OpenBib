import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Which shell bars a page keeps (signed-in shell; visitors always get theirs). */
export interface ShellChrome {
  /** Desktop and tablet top bar (breadcrumb and page actions). Default true. */
  topBar?: boolean;
  /** Phone top app bar (logo, actions, search, avatar). Default true. */
  mobileTopBar?: boolean;
}

export interface ShellSlots {
  /** The top bar's page-actions container, once mounted. */
  actionsEl: HTMLElement | null;
  /** No top bar on this viewport (useShellChrome): page actions render in place. */
  actionsInline: boolean;
  /** Hides or restores the shell's top bars for the current page. */
  setChrome: (chrome: Required<ShellChrome>) => void;
  /** Names the current page in the top bar breadcrumb (null restores the route name). */
  setTitle: (title: string | null) => void;
  /** Opens the command palette. */
  openPalette: () => void;
}

export const ShellContext = createContext<ShellSlots | null>(null);

export function useShell(): ShellSlots | null {
  return useContext(ShellContext);
}

/**
 * Page actions shown at the right of the app top bar. Outside the app shell
 * (the full-screen graph, isolated tests) they render in place instead.
 */
export function TopBarActions({ children }: { children: ReactNode }) {
  const shell = useContext(ShellContext);
  if (!shell || shell.actionsInline) return <>{children}</>;
  if (!shell.actionsEl) return null;
  return createPortal(children, shell.actionsEl);
}

/** Names the current page in the top bar breadcrumb, e.g. a collection's name. */
export function useTopBarTitle(title: string | null | undefined): void {
  const setTitle = useContext(ShellContext)?.setTitle;
  useEffect(() => {
    if (!setTitle || !title) return;
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
}

/**
 * Hides shell bars for the current page, restored when it unmounts. Pages
 * whose own header leads (Search, Settings) drop the breadcrumb bar; on phones
 * their sticky field or title header replaces the app bar. Without a bar,
 * TopBarActions render in place and sticky offsets (--nav-height) are 0.
 */
export function useShellChrome({ topBar = true, mobileTopBar = true }: ShellChrome): void {
  const setChrome = useContext(ShellContext)?.setChrome;
  // Before paint, so the bars never flash in and out.
  useLayoutEffect(() => {
    if (!setChrome) return;
    setChrome({ topBar, mobileTopBar });
    return () => setChrome({ topBar: true, mobileTopBar: true });
  }, [setChrome, topBar, mobileTopBar]);
}
