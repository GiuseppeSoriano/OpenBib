import { describe, expect, it } from "vitest";
import { collectionRead, safeReturnTo } from "../collection-access";

describe("Collection capability helpers", () => {
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/\n/evil.example", null, "relative"])("rejects unsafe return destination %s", (value) => {
    expect(safeReturnTo(value)).toBe("/");
  });
  it("keeps a valid internal destination and its fragment", () => {
    expect(safeReturnTo("/collections/abc#share=opaque")).toBe("/collections/abc#share=opaque");
  });
  it.each([403, 404])("replaces stale protected content when access returns %s", async (status) => {
    expect(await collectionRead(() => Promise.reject({ response: { status } }))).toBeNull();
  });
  it("does not mask network or server errors", async () => {
    await expect(collectionRead(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
  });
});
