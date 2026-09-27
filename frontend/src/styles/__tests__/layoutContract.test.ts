/*
 * jsdom has no layout engine, so the fixed-chrome clearance and target-size
 * rules are guarded here as a source contract (raw CSS, see vite.config.ts).
 */
import { describe, expect, it } from "vitest";
import tokensCss from "@/styles/tokens.css?raw";
import indexCss from "@/styles/index.css?raw";
import navCss from "@/components/nav/nav.css?raw";
import graphCss from "@/pages/GraphPage.css?raw";
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

const sources = { tokensCss, indexCss, navCss, graphCss, indexHtml };

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
    expect(root).toContain("--control-min: 32px;");
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
    for (const [name, css] of Object.entries({ indexCss, navCss, graphCss })) {
      expect(css, name).not.toContain("var(--bottomnav-height)");
    }
  });

  it("keeps panels scrollable above the safe area and locks the page behind dialogs", () => {
    expect(declarations(indexCss, "html")).toContain("font-size: 100%;");
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
});
