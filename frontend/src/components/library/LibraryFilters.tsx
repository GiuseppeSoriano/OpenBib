import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api, { library } from "@/lib/api";
import {
  activeFilterCount,
  DEFAULT_LIBRARY_SORT,
  LIBRARY_QUERY_MAX,
  LIBRARY_SORTS,
  type LibraryFilterParams,
} from "@/lib/libraryParams";
import type { ListboxOption } from "@/components/ui/Popover";
import FilterToolbar, { FilterMenu } from "@/components/filters/FilterToolbar";
import { READING_STATES, type Collection, type LibrarySort, type ReadingState } from "@/types";

const SORT_LABELS: Record<LibrarySort, string> = {
  added: "library.sortAdded",
  title: "library.sortTitle",
  year: "library.sortYear",
  citations: "library.sortCitations",
};

interface Props {
  params: LibraryFilterParams;
  /** `replace` is set for typed searches so each keystroke is not a history entry. */
  onChange: (next: LibraryFilterParams, options?: { replace?: boolean }) => void;
  onReset: () => void;
}

/**
 * Search, filters and sort for the Library list. The values live in the URL
 * (see lib/libraryParams); each filter is a chip that opens a listbox
 * popover, and on compact screens the chips fold behind a Filters toggle.
 */
export default function LibraryFilters({ params, onChange, onReset }: Props) {
  const { t } = useTranslation();
  const activeCount = activeFilterCount(params);

  const { data: facets } = useQuery({
    queryKey: ["library-entries", "facets"],
    queryFn: () => library.getFacets(),
  });
  const { data: collections } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<Collection[]>("/collections")).data,
  });

  const onQueryChange = useCallback(
    (q: string) => onChange({ ...params, q }, { replace: true }),
    [params, onChange],
  );

  const setFilter = (patch: LibraryFilterParams) => onChange({ ...params, ...patch });

  const withCount = (label: string, count: number | undefined) =>
    count === undefined ? label : t("library.optionCount", { label, count });

  const stateValues: ReadingState[] = facets
    ? READING_STATES.filter(
        (state) => state === params.state || facets.states.some((f) => f.state === state),
      )
    : READING_STATES;
  const stateCount = (state: ReadingState) => facets?.states.find((f) => f.state === state)?.count;
  const stateOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyState") },
    ...stateValues.map((state) => ({
      value: state,
      label: withCount(t(`paper.states.${state}`), stateCount(state)),
    })),
  ];

  const tagFacets = facets?.tags ?? [];
  const selectedTagMissing = !!params.tag && !tagFacets.some((f) => f.tag === params.tag);
  const tagOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyTag") },
    ...(selectedTagMissing && params.tag ? [{ value: params.tag, label: params.tag }] : []),
    ...tagFacets.map((facet) => ({ value: facet.tag, label: withCount(facet.tag, facet.count) })),
  ];

  const collectionList = collections ?? [];
  const selectedCollectionMissing =
    !!params.collection_id && !collectionList.some((c) => c.id === params.collection_id);
  const collectionOptions: ListboxOption<string>[] = [
    { value: "", label: t("library.anyCollection") },
    ...(selectedCollectionMissing && params.collection_id
      ? [{ value: params.collection_id, label: t("library.otherCollection") }]
      : []),
    ...collectionList.map((collection) => ({ value: collection.id, label: collection.name })),
  ];

  const sortOptions: ListboxOption<string>[] = LIBRARY_SORTS.map((sort) => ({
    value: sort,
    label: t(SORT_LABELS[sort]),
  }));
  const sort = params.sort ?? DEFAULT_LIBRARY_SORT;

  return (
    <FilterToolbar
      searchLabel={t("library.searchLabel")}
      searchPlaceholder={t("library.searchPlaceholder")}
      query={params.q ?? ""}
      maxLength={LIBRARY_QUERY_MAX}
      onQueryChange={onQueryChange}
      activeCount={activeCount}
      onReset={onReset}
      filters={
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
          {(tagFacets.length > 0 || params.tag) && (
            <FilterMenu
              label={t("library.filterTag")}
              options={tagOptions}
              value={params.tag ?? ""}
              valueLabel={params.tag}
              onSelect={(value) => setFilter({ tag: value || undefined })}
            />
          )}
          {(collectionList.length > 0 || params.collection_id) && (
            <FilterMenu
              label={t("library.filterCollection")}
              options={collectionOptions}
              value={params.collection_id ?? ""}
              valueLabel={
                params.collection_id
                  ? (collectionList.find((c) => c.id === params.collection_id)?.name ??
                    t("library.otherCollection"))
                  : undefined
              }
              onSelect={(value) => setFilter({ collection_id: value || undefined })}
            />
          )}
        </>
      }
      sort={
        <FilterMenu
          label={t("common.sortBy")}
          options={sortOptions}
          value={sort}
          valueLabel={t(SORT_LABELS[sort])}
          sort={sort !== DEFAULT_LIBRARY_SORT ? "changed" : "default"}
          onSelect={(value) => setFilter({ sort: value as LibrarySort })}
        />
      }
    />
  );
}
