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
function isPreprint(version: PaperMetadata): boolean {
  const type = (version.paper_type ?? "").toLowerCase();
  return (
    type.includes("preprint") ||
    type === "posted-content" ||
    version.provider_source === "arxiv" ||
    (!!version.arxiv_id && !version.doi)
  );
}

export function versionLabel(version: PaperMetadata, t: TFunction): string {
  const provider = providerLabel(version.provider_source);
  const year = version.publication_date?.slice(0, 4);

  if (version.version) {
    return `${t("paper.preprint")} ${version.version} · ${provider}`;
  }
  if (isPreprint(version)) {
    const head = [t("paper.preprint"), year].filter(Boolean).join(" ");
    return `${head} · ${provider}`;
  }
  if (year) {
    return `${t("paper.published")} ${year} · ${provider}`;
  }
  return `${t("paper.undated")} · ${provider}`;
}

export interface VersionLabel {
  /** Short visible label, unique among the sibling versions. */
  label: string;
  /** Unique accessible name: the label plus the details line. */
  accessibleName: string;
  /** Secondary line: date · venue · provider · citations. */
  details: string;
}

/** Full calendar date; ISO dates are read as UTC so they never shift a day. */
function formatDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  } catch {
    return value.slice(0, 10);
  }
}

/**
 * Labels for a set of sibling versions. Each starts from `versionLabel`;
 * versions that still share a label get, in order, their posted date, their
 * venue or preprint server, their citation count, and finally "n of m", so
 * every label (and accessible name) is distinct. Never shows a DOI or key.
 */
export function versionLabels(
  versions: PaperMetadata[],
  t: TFunction,
  locale: string,
): Map<string, VersionLabel> {
  const entries = versions.map((version) => ({ version, parts: [versionLabel(version, t)] }));
  const disambiguators: ((version: PaperMetadata) => string | null)[] = [
    (version) => {
      const date = formatDate(version.publication_date, locale);
      if (!date) return null;
      return isPreprint(version) ? t("paper.postedOn", { date }) : date;
    },
    (version) => version.venue?.trim() || null,
    (version) =>
      version.cited_by_count != null ? t("paper.citations", { count: version.cited_by_count }) : null,
  ];

  type Entry = (typeof entries)[number];
  const collisions = (): Entry[][] => {
    const byLabel = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = entry.parts.join(" · ");
      byLabel.set(key, [...(byLabel.get(key) ?? []), entry]);
    }
    return [...byLabel.values()].filter((group) => group.length > 1);
  };

  for (const disambiguate of disambiguators) {
    for (const group of collisions()) {
      const values = group.map((entry) => disambiguate(entry.version));
      if (new Set(values).size < 2) continue;
      group.forEach((entry, position) => {
        const value = values[position];
        if (value) entry.parts.push(value);
      });
    }
  }
  for (const group of collisions()) {
    group.forEach((entry, position) => {
      entry.parts.push(t("paper.versionOrdinal", { index: position + 1, total: group.length }));
    });
  }

  const labels = new Map<string, VersionLabel>();
  for (const { version, parts } of entries) {
    const label = parts.join(" · ");
    const details = [
      formatDate(version.publication_date, locale),
      version.venue?.trim() || null,
      version.provider_source ? providerLabel(version.provider_source) : null,
      version.cited_by_count != null ? t("paper.citations", { count: version.cited_by_count }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const accessibleName = details ? t("paper.versionAria", { label, details }) : label;
    labels.set(version.canonical_key, { label, accessibleName, details });
  }
  return labels;
}
