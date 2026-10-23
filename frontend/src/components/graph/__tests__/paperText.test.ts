import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { detailsStatus, nodeTitle } from "@/components/graph/paperText";
import type { GraphNode, PaperMetadata } from "@/types";

function version(key: string, title: string, provider = "semantic_scholar"): PaperMetadata {
  return {
    canonical_key: key,
    paper_group_key: "g",
    title,
    authors: [],
    provider_source: provider,
  } as unknown as PaperMetadata;
}

function node(versions: PaperMetadata[], extra: Partial<GraphNode> & { detailsUnavailable?: boolean } = {}): GraphNode {
  return {
    id: "g",
    label: null,
    type: versions.length > 1 ? "paper_group" : "paper",
    paper_group_key: "g",
    version_count: versions.length,
    selected_version: versions[0]!,
    versions,
    is_seed: false,
    ...extra,
  };
}

const LIST_DATA = version("doi:10.1049/iet-qtc.2020.0006", "doi:10.1049/iet-qtc.2020.0006");
const S2_LIST_DATA = version("s2:3d1b53060f176d54710375ebb5c4aaa47123c04c", "s2:3d1b53060f176d54710375ebb5c4aaa47123c04c");

describe("nodeTitle", () => {
  afterEach(() => void i18n.changeLanguage("en"));

  it("shows a loading placeholder, never the key, while details are pending", () => {
    const t = i18n.t.bind(i18n);
    for (const paper of [LIST_DATA, S2_LIST_DATA]) {
      const pending = node([paper], { details_pending: true });
      expect(detailsStatus(pending)).toBe("loading");
      expect(nodeTitle(pending, t)).toBe("Loading title…");
    }
  });

  it("says the title is unavailable once no refresh will bring it", () => {
    const t = i18n.t.bind(i18n);
    const given = node([LIST_DATA], { details_pending: true, detailsUnavailable: true });
    expect(detailsStatus(given)).toBe("unavailable");
    expect(nodeTitle(given, t)).toBe("Title unavailable");
    // A key-titled version the server did not flag is never shown raw either.
    expect(nodeTitle(node([LIST_DATA]), t)).toBe("Title unavailable");
  });

  it("is localized", async () => {
    await i18n.changeLanguage("it");
    const t = i18n.t.bind(i18n);
    expect(nodeTitle(node([LIST_DATA], { details_pending: true }), t)).toBe("Caricamento titolo…");
    expect(nodeTitle(node([LIST_DATA], { details_pending: true, detailsUnavailable: true }), t)).toBe("Titolo non disponibile");
  });

  it("shows real titles, including another version's on a pending node", () => {
    const t = i18n.t.bind(i18n);
    const preprint = version("arxiv:2101.00001", "Distributing entanglement");
    const pending = node([LIST_DATA, preprint], { details_pending: true });
    expect(detailsStatus(pending, preprint)).toBeNull();
    expect(nodeTitle(pending, t, preprint)).toBe("Distributing entanglement");
    expect(nodeTitle(node([preprint]), t)).toBe("Distributing entanglement");
    // Unresolved seeds keep their own wording.
    expect(nodeTitle(node([version("hash:x", "hash:x", "unknown")]), t)).toBe("Details unavailable");
  });
});
