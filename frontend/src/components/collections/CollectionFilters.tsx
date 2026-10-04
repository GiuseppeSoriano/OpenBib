import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  collectionFilterCount,
  COLLECTION_QUERY_MAX,
  COLLECTION_SORTS,
  DEFAULT_COLLECTION_SORT,
  type CollectionFilterParams,
  type CollectionSort,
  type RowAnnotations,
} from "@/lib/collectionParams";
import type { ListboxOption } from "@/components/ui/Popover";
import FilterToolbar, { FilterMenu } from "@/components/filters/FilterToolbar";
import { READING_STATES, type ReadingState } from "@/types";

const SORT_LABELS: Record<CollectionSort, string> = {
  position: "collections.sortPosition",
  added: "library.sortAdded",
  title: "library.sortTitle",
  year: "library.sortYear",
  citations: "library.sortCitations",
};

interface Props {
  params: CollectionFilterParams;
  /** `replace` is set for typed text so each keystroke is not a history entry. */
  onChange: (next: CollectionFilterParams, options?: { replace?: boolean }) => void;
  onReset: () => void;
  /**
   * The reader's own state and tags on every row, for the Reading state and
   * Tag filters; null for an anonymous viewer, who gets text and sort only.
   */
  annotations: RowAnnotations[] | null;
}

/**
 * Text filter, reading state, tag and sort over a collection's rows, in the
 * Library's toolbar. The values live in the URL (see lib/collectionParams).
 */
export default function CollectionFilters({ params, onChange, onReset, annotations }: Props) {
  const { t, i18n } = useTranslation();

  const onQueryChange = useCallback(
    (q: string) => onChange({ ...params, q }, { replace: true }),
    [params, onChange],
  );
  const setFilter = (patch: CollectionFilterParams) => onChange({ ...params, ...patch });
  const withCount = (label: string, count: number) => t("library.optionCount", { label, count });

  const stateCounts = new Map<ReadingState, number>();
  const tagCounts = new Map<string, number>();
  for (const row of annotations ?? []) {
    if (row.state) stateCounts.set(row.state, (stateCounts.get(row.state) ?? 0) + 1);
    for (const tag of row.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  const stateValues = READING_STATES.filter((state) => state === params.state || stateCounts.has(state));
  const stateOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyState") },
    ...stateValues.map((state) => ({
      value: state,
      label: withCount(t(`paper.states.${state}`), stateCounts.get(state) ?? 0),
    })),
  ];

  const collator = new Intl.Collator(i18n.resolvedLanguage ?? i18n.language, { sensitivity: "base" });
  const tagValues = Array.from(tagCounts.keys());
  if (params.tag && !tagCounts.has(params.tag)) tagValues.push(params.tag);
  tagValues.sort(collator.compare);
  const tagOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyTag") },
    ...tagValues.map((tag) => ({ value: tag, label: withCount(tag, tagCounts.get(tag) ?? 0) })),
  ];

  const sortOptions: ListboxOption<string>[] = COLLECTION_SORTS.map((sort) => ({
    value: sort,
    label: t(SORT_LABELS[sort]),
  }));
  const sort = params.sort ?? DEFAULT_COLLECTION_SORT;

  return (
    <FilterToolbar
      searchLabel={t("collections.filterLabel")}
      searchPlaceholder={t("library.searchPlaceholder")}
      query={params.q ?? ""}
      maxLength={COLLECTION_QUERY_MAX}
      onQueryChange={onQueryChange}
      activeCount={collectionFilterCount(params)}
      onReset={onReset}
      filters={
        annotations && (
          <>
            {stateValues.length > 0 && (
              <FilterMenu
                label={t("library.filterState")}
                options={stateOptions}
                value={params.state ?? ""}
                valueLabel={params.state ? t(`paper.states.${params.state}`) : undefined}
                onSelect={(value) => setFilter({ state: (value || undefined) as ReadingState | undefined })}
              />
            )}
            {tagValues.length > 0 && (
              <FilterMenu
                label={t("library.filterTag")}
                options={tagOptions}
                value={params.tag ?? ""}
                valueLabel={params.tag}
                onSelect={(value) => setFilter({ tag: value || undefined })}
              />
            )}
          </>
        )
      }
      sort={
        <FilterMenu
          label={t("common.sortBy")}
          options={sortOptions}
          value={sort}
          valueLabel={t(SORT_LABELS[sort])}
          sort={sort !== DEFAULT_COLLECTION_SORT ? "changed" : "default"}
          onSelect={(value) => setFilter({ sort: value as CollectionSort })}
        />
      }
    />
  );
}
