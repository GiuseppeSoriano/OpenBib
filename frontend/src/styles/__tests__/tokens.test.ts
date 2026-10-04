/*
 * WCAG contrast of the palette, read from tokens.css: text pairs keep 4.5:1
 * and the state/graph fills keep 3:1 against their grounds, in both themes.
 */
import { describe, expect, it } from "vitest";
import tokensCss from "@/styles/tokens.css?raw";

type Palette = Record<string, string>;

function block(selector: string): string {
  const clean = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = clean.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return clean.slice(start, clean.indexOf("}", start));
}

/** Hex colour tokens of a block, with var() references resolved. */
function palette(...blocks: string[]): Palette {
  const raw: Record<string, string> = {};
  for (const text of blocks) {
    for (const match of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) raw[match[1]!] = match[2]!.trim();
  }
  const resolve = (value: string, depth = 0): string => {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    return ref && depth < 5 ? resolve(raw[ref[1]!] ?? "", depth + 1) : value;
  };
  const out: Palette = {};
  for (const [name, value] of Object.entries(raw)) {
    const resolved = resolve(value);
    if (/^#[0-9a-f]{6}$/i.test(resolved)) out[name] = resolved;
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const light = palette(block(":root"));
const dark = palette(block(":root"), block('[data-theme="dark"]'));

const TEXT: [string, string][] = [
  ["--color-text", "--color-bg"],
  ["--color-text", "--color-sidebar"],
  ["--color-text", "--color-surface"],
  ["--color-text-body", "--color-bg"],
  ["--color-text-secondary", "--color-bg"],
  ["--color-text-secondary", "--color-surface"],
  ["--color-text-muted", "--color-bg"],
  ["--color-text-muted", "--color-sidebar"],
  ["--color-text-muted", "--color-surface"],
  ["--color-accent", "--color-bg"],
  ["--color-accent-strong", "--color-accent-soft"],
  ["--color-on-accent", "--color-accent"],
  ["--color-state-toread-text", "--color-state-toread-soft"],
  ["--color-state-reading-text", "--color-state-reading-soft"],
  ["--color-state-read-text", "--color-state-read-soft"],
];

const NON_TEXT: [string, string][] = [
  ["--color-rule", "--color-bg"],
  // The selected segment's outline, against the control and its own fill.
  ["--color-accent", "--color-surface"],
  ["--color-accent", "--color-accent-soft"],
  ["--color-state-toread", "--color-bg"],
  ["--color-state-reading", "--color-bg"],
  ["--color-state-read", "--color-bg"],
  ["--graph-node-pinned", "--color-bg"],
  ["--graph-node-saved", "--color-bg"],
  ["--graph-node-selected", "--color-bg"],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme contrast", (_name, colors) => {
  it.each(TEXT)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(colors[fg], fg).toBeDefined();
    expect(colors[bg], bg).toBeDefined();
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT)("%s on %s is at least 3:1", (fg, bg) => {
    expect(contrast(colors[fg]!, colors[bg]!)).toBeGreaterThanOrEqual(3);
  });
});

describe("shell tokens", () => {
  it("defines the redesign grounds and lines in both themes", () => {
    expect(light["--color-sidebar"]).toBe("#fbfcfb");
    expect(light["--color-hairline"]).toBe("#e3e8e6");
    expect(light["--color-rule"]).toBe("#1a1e1d");
    expect(dark["--color-bg"]).toBe("#101413");
    expect(dark["--color-sidebar"]).toBe("#0d1110");
    expect(dark["--color-hairline"]).toBe("#222c29");
    expect(dark["--color-rule"]).toBe("#5a6863");
  });
});
