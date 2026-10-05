import { describe, it, expect } from "vitest";
import { abstractParagraphs, abstractPreview } from "@/lib/abstract";

describe("abstractParagraphs", () => {
  it("splits normalized text into labelled paragraphs", () => {
    expect(abstractParagraphs("Background: A study.\n\nResults: It works.")).toEqual([
      { label: "Background", text: "A study." },
      { label: "Results", text: "It works." },
    ]);
  });

  it("keeps unlabelled paragraphs and collapses stray whitespace", () => {
    expect(abstractParagraphs("First line\ncontinues.\n\n\n  Second.  ")).toEqual([
      { text: "First line continues." },
      { text: "Second." },
    ]);
  });

  it("does not treat lowercase or long prefixes as labels", () => {
    expect(abstractParagraphs("we note: this is text")).toEqual([{ text: "we note: this is text" }]);
    const long = "A very long sentence that keeps going past forty characters: then";
    expect(abstractParagraphs(long)).toEqual([{ text: long }]);
  });

  it("keeps literal comparisons", () => {
    expect(abstractParagraphs("Effect p < 0.05 and q > 1.")).toEqual([
      { text: "Effect p < 0.05 and q > 1." },
    ]);
  });

  // Same rule as the backend (app/common/text.py): only known tags with
  // name=value attributes are markup; anything else is kept as text.
  it.each([
    "Rust Box<T> values where x<y holds for all inputs.",
    "We replace tokens with <mask> and predict them; accuracy improves when n<k.",
    "tokens <mask> and </s>",
    "when x<a and y>b holds",
    "n<p and m>q",
    "the <style> element is parsed first. Then scripts run.",
  ])("keeps tag-like literal text unchanged: %s", (text) => {
    expect(abstractParagraphs(text)).toEqual([{ text }]);
  });

  it("strips known markup but keeps literal text around it", () => {
    expect(abstractParagraphs("<i>x</i> and Box<T>")).toEqual([{ text: "x and Box<T>" }]);
    expect(abstractParagraphs('<p>if x<a and y>b then <a href="https://e.org">z</a></p>')).toEqual([
      { text: "if x<a and y>b then z" },
    ]);
    expect(abstractParagraphs("<jats:p>n &lt; k holds</jats:p>")).toEqual([{ text: "n < k holds" }]);
  });

  it("strips leftover markup defensively without rendering it", () => {
    const paragraphs = abstractParagraphs(
      "<h4>Background</h4>Odor <i>coding</i>.<h4>Results</h4>10<sup>-3</sup> fold<script>alert(1)</script>",
    );
    expect(paragraphs).toEqual([
      { label: "Background", text: "Odor coding." },
      { label: "Results", text: "10^-3 fold" },
    ]);
  });

  it("survives malformed markup", () => {
    const paragraphs = abstractParagraphs("<p>Unclosed <b>bold <i>text");
    expect(paragraphs).toEqual([{ text: "Unclosed bold text" }]);
    expect(JSON.stringify(abstractParagraphs("<jats:p>A</jats:p><jats:p>B"))).not.toContain("<");
  });

  it("returns nothing for empty input", () => {
    expect(abstractParagraphs(null)).toEqual([]);
    expect(abstractParagraphs("   ")).toEqual([]);
  });
});

describe("abstractPreview", () => {
  it("joins paragraphs on one line, keeping labels", () => {
    expect(abstractPreview("Background: A.\n\nResults: B.")).toBe("Background: A. Results: B.");
  });

  it("never leaks markup and is bounded", () => {
    expect(abstractPreview("<h4>Aim</h4><p>Short</p>")).toBe("Aim: Short");
    const preview = abstractPreview("word ".repeat(500), 100);
    expect(preview.length).toBeLessThanOrEqual(100);
    expect(preview.endsWith("…")).toBe(true);
  });
});
