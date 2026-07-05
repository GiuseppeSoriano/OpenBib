import type { TFunction } from "i18next";
import type { PaperMetadata } from "@/types";

const PROVIDER_LABELS: Record<string, string> = {
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  europepmc: "Europe PMC",
};

export function providerLabel(name: string | null | undefined): string {
  if (!name) return "—";
  return PROVIDER_LABELS[name] ?? name;
}

/**
 * Human-readable label for a paper version — the user never sees raw
 * canonical keys or DOIs. Examples:
 *   "Preprint v2 · arXiv"
 *   "Published 2017 · Crossref"
 *   "2019 · OpenAlex"
 */
export function versionLabel(version: PaperMetadata, t: TFunction): string {
  const provider = providerLabel(version.provider_source);
  const year = version.publication_date?.slice(0, 4);
  const type = (version.paper_type ?? "").toLowerCase();
  const isPreprint =
    type.includes("preprint") ||
    type === "posted-content" ||
    version.provider_source === "arxiv" ||
    (!!version.arxiv_id && !version.doi);

  if (version.version) {
    return `${t("paper.preprint")} ${version.version} · ${provider}`;
  }
  if (isPreprint) {
    const head = [t("paper.preprint"), year].filter(Boolean).join(" ");
    return `${head} · ${provider}`;
  }
  if (year) {
    return `${t("paper.published")} ${year} · ${provider}`;
  }
  return `${t("paper.undated")} · ${provider}`;
}
