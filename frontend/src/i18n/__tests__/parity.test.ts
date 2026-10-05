import { describe, expect, it } from "vitest";
import enLocale from "../locales/en.json";
import itLocale from "../locales/it.json";

type LocaleTree = { [key: string]: unknown };

function flatten(tree: LocaleTree, prefix = "", out: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flatten(value as LocaleTree, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** Interpolation names, including formatted ones such as `{{count, number}}`. */
function placeholders(value: string): string[] {
  const names = new Set<string>();
  const pattern = /\{\{\s*([^,}\s]+)\s*(?:,[^}]*)?\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) names.add(match[1]!);
  return Array.from(names).sort();
}

const en = flatten(enLocale as LocaleTree);
const it_ = flatten(itLocale as LocaleTree);

describe("locale parity (en ⇄ it)", () => {
  it("parses plain and formatted placeholders", () => {
    expect(placeholders("{{start}}–{{ end }} of {{total, number}}")).toEqual([
      "end",
      "start",
      "total",
    ]);
  });

  it("has the same keys in both languages", () => {
    const enKeys = Object.keys(en);
    const itKeys = Object.keys(it_);
    expect(enKeys.filter((key) => !(key in it_))).toEqual([]);
    expect(itKeys.filter((key) => !(key in en))).toEqual([]);
  });

  it("has no empty or non-string values", () => {
    const bad = [
      ...Object.entries(en).map(([key, value]) => ["en", key, value] as const),
      ...Object.entries(it_).map(([key, value]) => ["it", key, value] as const),
    ]
      .filter(([, , value]) => typeof value !== "string" || value.trim() === "")
      .map(([lang, key]) => `${lang}:${key}`);
    expect(bad).toEqual([]);
  });

  it("uses the same interpolation variables for every key", () => {
    const mismatched = Object.keys(en)
      .filter((key) => typeof en[key] === "string" && typeof it_[key] === "string")
      .filter(
        (key) =>
          placeholders(en[key] as string).join(",") !== placeholders(it_[key] as string).join(","),
      );
    expect(mismatched).toEqual([]);
  });
});
