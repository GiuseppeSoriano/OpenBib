/*
 * jsdom has no layout engine, so the fixed-chrome clearance and target-size
 * rules are guarded here as a source contract (raw CSS, see vite.config.ts).
 */
import { describe, expect, it } from "vitest";
import tokensCss from "@/styles/tokens.css?raw";
import indexCss from "@/styles/index.css?raw";
import navCss from "@/components/nav/nav.css?raw";
import shellCss from "@/components/shell/shell.css?raw";
import graphCss from "@/pages/GraphPage.css?raw";
import graphHeaderCss from "@/components/graph/graph.css?raw";
import searchFiltersCss from "@/components/search/SearchFilters.css?raw";
import settingsCss from "@/pages/SettingsPage.css?raw";
import securityCss from "@/components/settings/SecuritySettings.css?raw";
import stateChipCss from "@/components/paper/ReadingStateSelect.css?raw";
import indexHtml from "../../../index.html?raw";
import { COMPACT_QUERY, TOUCH_QUERY } from "@/lib/breakpoints";

interface Rule {
  selectors: string[];
  body: string;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Innermost `selector { declarations }` blocks, comments removed, whitespace collapsed. */
function rules(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const pattern = /([^{}]*)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    out.push({ selectors: match[1]!.split(",").map(squash), body: squash(match[2]!) });
  }
  return out;
}

/** All declarations written for `selector`, across every block and media query. */
function declarations(css: string, selector: string): string {
  return rules(css)
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join(" ");
}

const sources = {
  tokensCss,
  indexCss,
  navCss,
  shellCss,
  graphCss,
  graphHeaderCss,
  searchFiltersCss,
  settingsCss,
  securityCss,
  stateChipCss,
  indexHtml,
};

/** The block whose selector list is exactly `selectors` (one shared rule). */
function sharedRule(css: string, selectors: string[]): string {
  const rule = rules(css).find(
    (r) => r.selectors.length === selectors.length && selectors.every((s) => r.selectors.includes(s)),
  );
  return rule?.body ?? "";
}

describe("layout contract", () => {
  it("loads every source as raw text", () => {
    for (const [name, text] of Object.entries(sources)) {
      expect(text.length, name).toBeGreaterThan(100);
    }
  });

  it("defines the clearance, safe-area and target-size tokens", () => {
    const root = declarations(tokensCss, ":root");
    expect(root).toContain("--safe-area-bottom: env(safe-area-inset-bottom, 0px);");
    expect(root).toContain("--bottomnav-clearance: 0px;");
    expect(root).toContain("--touch-target: 44px;");
    expect(root).toContain("--control-min: 34px;");
    expect(root).toMatch(/--nav-height: calc\([\d.]+rem \+ \d+px\);/);
    expect(root).toMatch(/--bottomnav-height: calc\([\d.]+rem \+ \d+px\);/);

    const tokens = squash(tokensCss);
    expect(tokens).toContain(
      "@media (max-width: 639px) { :root { --bottomnav-clearance: calc(var(--bottomnav-height) + var(--safe-area-bottom)); } }",
    );
    expect(tokens).toContain(`@media ${TOUCH_QUERY} { :root { --control-min: var(--touch-target); } }`);
    // Mirror comment for the query that CSS does not use directly yet.
    expect(tokens).toContain(COMPACT_QUERY);
  });

  it("clears the tab bar once, after the footer, on the app shell", () => {
    const shell = declarations(navCss, ".app-shell");
    expect(shell).toContain("display: flex;");
    expect(shell).toContain("flex-direction: column;");
    expect(shell).toContain("min-height: 100dvh;");
    expect(shell).toContain("padding-bottom: var(--bottomnav-clearance);");

    const main = declarations(navCss, ".app-main");
    expect(main).toContain("flex: 1 0 auto;");
    expect(main).not.toMatch(/min-height:\s*100vh/);
    expect(main).not.toContain("padding-bottom");

    const tabbar = declarations(navCss, ".tabbar");
    expect(tabbar).toContain("height: var(--bottomnav-clearance);");
    expect(tabbar).toContain("padding-bottom: var(--safe-area-bottom);");
  });

  it("uses the clearance token for every other fixed bottom surface", () => {
    expect(declarations(graphCss, ".graph-screen")).toContain(
      "bottom: var(--bottomnav-clearance);",
    );
    expect(declarations(indexCss, ".toast-container")).toContain(
      "bottom: calc(var(--bottomnav-clearance) + var(--space-md));",
    );
    for (const [name, css] of Object.entries({ indexCss, navCss, shellCss, graphCss })) {
      expect(css, name).not.toContain("var(--bottomnav-height)");
    }
  });

  it("keeps panels scrollable above the safe area and locks the page behind dialogs", () => {
    expect(declarations(indexCss, "html")).toContain("font-size: 100%;");
    expect(declarations(indexCss, "html")).toContain("scroll-padding-top: var(--nav-height);");
    expect(declarations(indexCss, "html")).toContain(
      "scroll-padding-bottom: var(--bottomnav-clearance);",
    );
    expect(declarations(indexCss, "html.has-modal")).toContain("overflow: hidden;");
    const body = declarations(indexCss, ".panel-body");
    expect(body).toContain("overscroll-behavior: contain;");
    expect(body).toContain("padding-bottom: calc(var(--space-lg) + var(--safe-area-bottom));");
    expect(declarations(indexCss, ".panel--bottom")).toContain("max-height: 88dvh;");
  });

  it("keeps edge-anchored surfaces clear of the landscape side insets", () => {
    const right = "max(var(--space-lg), env(safe-area-inset-right, 0px))";
    const left = "max(var(--space-lg), env(safe-area-inset-left, 0px))";
    expect(declarations(indexCss, ".panel-header")).toContain(`padding-right: ${right};`);
    expect(declarations(indexCss, ".panel-body")).toContain(`padding-right: ${right};`);
    expect(declarations(indexCss, ".panel--bottom .panel-body")).toContain(`padding-left: ${left};`);
    expect(declarations(indexCss, ".toast-container")).toContain(`right: ${right};`);
    const graph = declarations(graphCss, ".graph-screen");
    expect(graph).toContain("left: env(safe-area-inset-left, 0px);");
    expect(graph).toContain("right: env(safe-area-inset-right, 0px);");
  });

  it("opts into safe areas and keyboard-aware resizing in the viewport meta", () => {
    const viewport = indexHtml.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("interactive-widget=resizes-content");
  });

  it("gives header, dialog-close and footer controls a full touch target", () => {
    const targets: [string, string][] = [
      [navCss, ".topnav-iconbtn"],
      [navCss, ".user-menu-btn"],
      [shellCss, ".topbar-iconbtn"],
      [indexCss, ".theme-toggle"],
      [indexCss, ".panel-header .btn-ghost"],
      [indexCss, ".modal-close"],
      [indexCss, ".toast-close"],
    ];
    for (const [css, selector] of targets) {
      const decls = declarations(css, selector);
      expect(decls, selector).toContain("min-width: var(--touch-target);");
      expect(decls, selector).toContain("min-height: var(--touch-target);");
    }
    expect(declarations(navCss, ".app-footer a")).toContain("min-height: var(--touch-target);");
  });

  it("lets buttons, menus and the tab bar reflow instead of widening the page", () => {
    const btn = declarations(indexCss, ".btn");
    expect(btn).not.toContain("white-space: nowrap");
    expect(btn).toContain("max-width: 100%;");
    expect(btn).toContain("flex-shrink: 0;");
    expect(declarations(indexCss, ".segmented")).toContain("flex-wrap: wrap;");

    const menu = declarations(indexCss, ".menu-popover");
    expect(menu).toContain("max-width: min(22rem, calc(100vw - 2 * var(--space-md)));");
    expect(menu).toContain("translate: var(--menu-shift, 0px) 0;");
    const label = declarations(indexCss, ".menu-item-label");
    expect(label).toContain("min-width: 0;");
    expect(label).toContain("-webkit-line-clamp: 2;");
    expect(label).not.toContain("white-space: nowrap");

    expect(declarations(navCss, ".tabbar-link")).toContain("min-width: 0;");
    expect(declarations(navCss, ".tabbar-link span")).toContain("text-overflow: ellipsis;");
  });

  it("compacts the app and graph headers with em container queries", () => {
    expect(declarations(navCss, ".topnav")).toContain("container: topnav / inline-size;");
    const nav = squash(navCss);
    // The container is the content box: the viewport minus 2em of padding
    // below 640px. With the Search link added, labels give way in turn so the
    // bar fits a 320px screen at 100% text: Search on phones, Sign in below a
    // 390px viewport (356px box = 22.25em), the wordmark below 332px (18.75em).
    expect(nav).toMatch(/@container topnav \(max-width: 29\.99em\) \{ \.topnav-search-label \{/);
    expect(nav).toMatch(/@container topnav \(max-width: 22\.25em\) \{ \.topnav-signin-label \{/);
    expect(nav).toMatch(/@container topnav \(max-width: 18\.75em\) \{ \.topnav-wordmark \{/);
    expect(declarations(shellCss, ".topbar--mobile")).toContain("container: topbar / inline-size;");
    expect(squash(shellCss)).toMatch(/@container topbar \(max-width: [\d.]+em\) \{ \.topbar-wordmark \{/);
    expect(nav).not.toContain("@media (max-width: 359px)");

    expect(declarations(graphHeaderCss, ".graph-header")).toContain(
      "container: graph-header / inline-size;",
    );
    const graph = squash(graphHeaderCss);
    expect(graph).not.toMatch(/@container graph-header \([^)]*px\)/);
    // Narrow: the title keeps a row of its own; the controls wrap below it.
    expect(graph).toMatch(
      /@container graph-header \(max-width: [\d.]+em\) \{ \.graph-header-row \{ flex-wrap: wrap;/,
    );
    const seed = declarations(graphHeaderCss, ".graph-title-seed");
    expect(seed).toContain("min-width: 0;");
    expect(seed).toContain("text-overflow: ellipsis;");
  });

  it("sizes buttons, chips and inputs from the control token", () => {
    for (const selector of [".btn", ".chip", ".pill", ".input", ".menu-item"]) {
      expect(declarations(indexCss, selector), selector).toContain(
        "min-height: var(--control-min);",
      );
    }
    // The compact controls grow to the full target on touch screens; the
    // popover options follow --control-min, which is 44px there.
    const touch = squash(indexCss);
    expect(touch).toContain(
      `@media ${TOUCH_QUERY} { .btn--sm, .btn-quiet { min-height: var(--touch-target); } .btn-quiet--icon { min-width: var(--touch-target); } }`,
    );
    expect(declarations(indexCss, ".popover-option")).toContain("min-height: var(--control-min);");
    const chip = declarations(indexCss, ".chip");
    expect(chip).toContain("max-width: 100%;");
    expect(chip).not.toContain("white-space: nowrap");
    // Shell links outside the button classes follow the token too.
    for (const selector of [".sidebar-recent-link", ".breadcrumb a"]) {
      expect(declarations(shellCss, selector), selector).toContain("min-height: var(--control-min);");
    }
  });

  it("marks the selected segment with more than its fill (non-text 3:1)", () => {
    for (const selector of ['.segmented button.active', '.segmented button[aria-pressed="true"]', '.segmented button[aria-checked="true"]']) {
      expect(declarations(indexCss, selector), selector).toContain("border-color: var(--color-accent);");
    }
    const segment = declarations(indexCss, ".segmented button");
    expect(segment).toContain("color: var(--color-text);");
    // Its own rounded border inside the track: nothing doubled or clipped at the corners.
    expect(segment).toContain("border: 1px solid transparent;");
    expect(declarations(indexCss, ".segmented")).not.toContain("overflow: hidden");
  });

  it("has one caps label style and one overlay heading", () => {
    // The page eyebrow is the sidebar's and the popovers' caps label.
    const caps = sharedRule(indexCss, [".label-caps", ".page-header-eyebrow"]);
    expect(caps).toContain("font-family: var(--font-sans);");
    expect(caps).toContain("font-size: var(--text-2xs);");
    expect(caps).toContain("font-weight: 500;");
    expect(caps).toContain("letter-spacing: var(--tracking-caps);");
    for (const [name, css] of Object.entries(sources)) {
      expect(css, name).not.toContain("--tracking-caps-wide");
    }
    // Dialogs and sheets (details, graph controls, the Filters sheet) share
    // the serif title; no sheet title is a caps label any more.
    const title = sharedRule(indexCss, [".modal-title", ".panel-title"]);
    expect(title).toContain("font-family: var(--font-serif);");
    expect(title).toContain("font-size: var(--text-xl);");
    expect(declarations(indexCss, ".panel-title")).not.toContain("text-transform");
    expect(declarations(searchFiltersCss, ".search-sheet-title")).not.toContain("font-size");
  });

  it("bounds menus to the viewport height, as a fixed sidebar cannot scroll them into view", () => {
    const menu = declarations(indexCss, ".menu-popover");
    expect(menu).toContain("max-height: var(--menu-max-height, calc(100vh - 2 * var(--space-md)));");
    expect(menu).toContain("overflow-y: auto;");
    expect(menu).toContain("overscroll-behavior: contain;");
  });

  it("keeps popovers inside the viewport like menus", () => {
    const popover = declarations(indexCss, ".popover");
    expect(popover).toContain("max-width: min(22rem, calc(100vw - 2 * var(--space-md)));");
    expect(popover).toContain("translate: var(--popover-shift, 0px) 0;");
  });

  it("zeroes motion under prefers-reduced-motion", () => {
    expect(squash(tokensCss)).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ :root \{ --duration-fast: 0ms; --duration-base: 0ms; --duration-slow: 0ms; \} \}/,
    );
    expect(squash(indexCss)).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation-duration: 0\.01ms !important;/,
    );
  });

  it("reserves the sidebar's width so it never covers the page", () => {
    const sidebar = declarations(shellCss, ".sidebar");
    expect(sidebar).toContain("position: fixed;");
    expect(sidebar).toContain("width: calc(var(--sidebar-width) + env(safe-area-inset-left, 0px));");
    expect(declarations(shellCss, ".sidebar--rail")).toContain(
      "width: calc(var(--sidebar-rail-width) + env(safe-area-inset-left, 0px));",
    );
    expect(declarations(shellCss, ".app-shell--sidebar")).toContain(
      "padding-left: calc(var(--sidebar-width) + env(safe-area-inset-left, 0px));",
    );
    expect(declarations(shellCss, ".app-shell--rail")).toContain(
      "padding-left: calc(var(--sidebar-rail-width) + env(safe-area-inset-left, 0px));",
    );
    expect(declarations(tokensCss, ":root")).toContain("--sidebar-rail-width: 64px;");
  });

  it("keeps the top bars sticky at the nav height and zeroes clearances the shell lacks", () => {
    for (const [css, selector] of [[shellCss, ".topbar"], [navCss, ".topnav"]] as const) {
      const decls = declarations(css, selector);
      expect(decls, selector).toContain("position: sticky;");
      expect(decls, selector).toContain("top: 0;");
      expect(decls, selector).toMatch(/(min-)?height: var\(--nav-height\);/);
    }
    // Visitors have no tab bar; the full-screen graph has no top bar.
    expect(declarations(navCss, ".app-shell--anon")).toContain("--bottomnav-clearance: 0px;");
    expect(declarations(navCss, ".app-shell--bare")).toContain("--nav-height: 0px;");
    expect(declarations(navCss, ".app-shell--no-topbar")).toContain("--nav-height: 0px;");
    // On the root too: portaled toasts and the html scroll padding read it there.
    expect(declarations(navCss, ":root:has(.app-shell--anon)")).toContain("--bottomnav-clearance: 0px;");
    expect(declarations(navCss, ":root:has(.app-shell--bare)")).toContain("--nav-height: 0px;");
    expect(declarations(navCss, ":root:has(.app-shell--no-topbar)")).toContain("--nav-height: 0px;");
    expect(declarations(navCss, ".app-main")).not.toContain("padding-top");
  });

  it("keeps the command palette inside the viewport", () => {
    const palette = declarations(shellCss, ".palette");
    expect(palette).toContain("width: min(40rem, 100%);");
    expect(palette).toContain("max-height: min(32rem, 76dvh);");
    expect(declarations(shellCss, ".palette-list")).toContain("overflow-y: auto;");
    expect(declarations(shellCss, ".palette-option")).toContain("min-height: var(--control-min);");
  });

  describe("sibling controls are identical by construction", () => {
    it("draws every control and list row on the 6px radius token, never a literal 5px or 8px", () => {
      for (const [name, css] of Object.entries({ indexCss, settingsCss, shellCss, navCss })) {
        expect(css, name).not.toMatch(/border-radius: (5|8)px/);
      }
      for (const selector of [".btn", ".btn-quiet", ".chip", ".menu-item", ".input"]) {
        expect(declarations(indexCss, selector), selector).toContain("border-radius: var(--radius-sm);");
      }
      expect(declarations(settingsCss, ".settings-theme-card")).toContain("border-radius: var(--radius-sm);");
    });

    it("shares one list-row spec across menus, listbox options and the palette", () => {
      const row = sharedRule(indexCss, [".menu-item", ".popover-option"]);
      for (const decl of [
        "min-height: var(--control-min);",
        "padding: 0.375rem 10px;",
        "border-radius: var(--radius-sm);",
        "font-size: var(--text-md);",
        "line-height: var(--leading-tight);",
      ]) {
        expect(row, decl).toContain(decl);
        expect(declarations(shellCss, ".palette-option"), decl).toContain(decl);
      }
      expect(sharedRule(indexCss, [".menu-item:focus-visible", ".popover-option:focus-visible"])).toContain(
        "box-shadow: var(--focus-ring-inset);",
      );
      expect(declarations(tokensCss, ":root")).toContain("--focus-ring-inset: inset 0 0 0 2px var(--color-accent);");
      // A wrapped palette name clamps like a menu label; the active row has no bent left bar.
      expect(declarations(shellCss, ".palette-option-label")).toContain("-webkit-line-clamp: 2;");
      expect(declarations(shellCss, ".palette-option--active")).not.toContain("inset 2px 0 0");
      // Icons and checks share one 16px column, so labels start at one x.
      expect(declarations(indexCss, ".menu-item > svg")).toContain("width: var(--icon-row);");
      expect(declarations(indexCss, ".menu-item-check")).toContain("width: var(--icon-row);");
      expect(declarations(indexCss, ".menu-header")).toContain("padding: var(--space-sm) 10px;");
      // Sign out is set apart by its colour and separator, not a heavier weight.
      expect(navCss).not.toContain("menu-item--signout");
    });

    it("sizes icons by role: one in buttons, one for rows and every close X", () => {
      const root = declarations(tokensCss, ":root");
      expect(root).toContain("--icon-btn: 15px;");
      expect(root).toContain("--icon-row: 16px;");
      expect(declarations(indexCss, ".btn > svg")).toContain("width: var(--icon-btn);");
      for (const selector of [".panel-header .btn-ghost > svg", ".modal-close > svg", ".toast-close > svg"]) {
        expect(declarations(indexCss, selector), selector).toContain("width: var(--icon-row);");
      }
    });

    it("gives the visitors' Search link and Sign in one type size, gap and height", () => {
      expect(declarations(navCss, ".topnav-search")).toContain("font-size: var(--text-md);");
      expect(declarations(navCss, ".topnav-search")).toContain("gap: var(--space-sm);");
      expect(declarations(navCss, ".topnav-search > svg")).toContain("width: var(--icon-btn);");
      const signin = declarations(navCss, ".topnav-signin");
      expect(signin).not.toContain("font-size");
      expect(signin).not.toContain("padding");
      expect(signin).toContain("min-height: var(--touch-target);");
    });

    it("shapes chips alike on every page: 6px on desktop, pills on compact screens", () => {
      expect(squash(indexCss)).toContain(
        "@media (max-width: 639px), (max-height: 500px) { .chip { border-radius: var(--radius-full); } .chip-remove { border-radius: 0 var(--radius-full) var(--radius-full) 0; } }",
      );
      expect(searchFiltersCss).not.toContain(".chip");
      // The reading-state trigger among a row's quiet actions is one of them.
      expect(declarations(stateChipCss, ".state-chip")).not.toContain("font-weight");
      const quiet = declarations(stateChipCss, ".paper-actions .state-chip");
      expect(quiet).toContain("border-color: transparent;");
      expect(quiet).toContain("min-height: 30px;");
    });

    it("splits block segmented groups equally and keeps inline ones hugging their labels", () => {
      expect(declarations(indexCss, ".segmented button")).toContain("flex: 1 1 auto;");
      const block = declarations(indexCss, ".segmented--block button");
      expect(block).toContain("flex: 1 1 0;");
      expect(block).toContain("min-width: 0;");
    });

    it("draws toasts with a uniform border; the icon carries the status", () => {
      const toast = declarations(indexCss, ".toast");
      expect(toast).toContain("border: 1px solid var(--color-border-strong);");
      expect(toast).not.toContain("border-left");
      expect(indexCss).not.toContain(".toast::before");
      for (const variant of ["success", "error", "info"]) {
        expect(declarations(indexCss, ".toast--" + variant + " .toast-icon"), variant).toMatch(/^color: var\(--color-[a-z]+\);$/);
      }
    });

    it("leaves room for a 3px focus ring inside clipping scroll boxes", () => {
      expect(declarations(shellCss, ".sidebar-scroll")).toContain("padding: 4px;");
      expect(declarations(indexCss, ".chip-row--scroll")).toContain("padding: 4px;");
      expect(declarations(shellCss, ".sidebar-link:focus-visible")).toContain("z-index: 1;");
      // Settings deep-link targets get an offset ring, clear of their text.
      const target = sharedRule(settingsCss, [".settings-section:focus-visible", ".settings-row:focus-visible"]);
      expect(target).toContain("outline-offset: 6px;");
      expect(target).not.toContain("box-shadow");
    });

    it("lines the sidebar's brand, search and account rows up on the nav rows' columns", () => {
      expect(declarations(shellCss, ".sidebar-search")).toContain("padding: 0.25rem 9px;");
      expect(declarations(shellCss, ".sidebar-search")).toContain("gap: 10px;");
      expect(declarations(shellCss, ".sidebar-account")).toContain("padding: 6px 7px;");
      expect(declarations(shellCss, ".sidebar-account .user-avatar")).toContain("width: 22px;");
      expect(declarations(shellCss, ".topbar-brand")).toContain("flex: 0 1 auto;");
    });

    it("places Settings controls in the second column on every row", () => {
      expect(squash(securityCss)).toContain(
        "@container (min-width: 32rem) { .settings-security-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
      );
      expect(declarations(securityCss, ".settings-security-row")).toContain("align-items: start;");
      expect(declarations(securityCss, ".settings-security-action")).toContain("justify-self: start;");
    });

    it("keeps graph controls on the app's button, field and tab rules", () => {
      expect(declarations(graphHeaderCss, ".graph-btn")).not.toContain("font-size");
      expect(declarations(graphHeaderCss, ".graph-view-btn")).toContain("font-size: var(--text-md);");
      expect(declarations(graphHeaderCss, ".graph-list-filter-input")).toContain(
        "border: 1px solid var(--color-border-strong);",
      );
      expect(declarations(indexCss, "input")).toContain("font-family: inherit;");
      expect(declarations(graphHeaderCss, ".graph-sheet-tab")).toContain("margin-bottom: -1px;");
      expect(declarations(graphHeaderCss, ".graph-range-gap")).toContain("font-size: var(--text-sm);");
      const meta = declarations(graphHeaderCss, ".graph-summary-meta");
      expect(meta).toContain("display: block;");
      expect(meta).not.toContain("column-gap");
      expect(declarations(graphHeaderCss, ".graph-summary-range")).toContain("white-space: nowrap;");
      expect(declarations(indexCss, ".sheet-submit")).toContain("width: 100%;");
    });
  });
});
