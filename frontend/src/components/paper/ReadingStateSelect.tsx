import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { papers } from "@/lib/api";
import { READING_STATES, type PaperState, type ReadingState } from "@/types";

/**
 * Select bound to the per-version reading state endpoints. `fromList`: a row
 * of a list whose response seeds this query and keeps it fresh, so the row
 * never refetches by itself (a long list would cost a request per row).
 */
export default function ReadingStateSelect({
  paperKey,
  fromList = false,
}: {
  paperKey: string;
  fromList?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: states } = useQuery({
    queryKey: ["paper-states", paperKey],
    queryFn: () => papers.getStates(paperKey),
    ...(fromList ? { staleTime: Infinity } : {}),
  });

  const mutation = useMutation({
    mutationFn: (state: ReadingState) => papers.setState(paperKey, state),
    onSuccess: (saved) => {
      // States are per exact key, so the saved row is the whole list: no refetch.
      queryClient.setQueryData<PaperState[]>(["paper-states", paperKey], [saved]);
      // State-filtered Library pages and the state facets.
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
    },
  });

  const current = states?.find((s) => s.paper_canonical_key === paperKey)?.state ?? "";

  return (
    <select
      className="input reading-state-select"
      value={current}
      onChange={(e) => {
        if (e.target.value) mutation.mutate(e.target.value as ReadingState);
      }}
      disabled={mutation.isPending}
      aria-label={t("paper.readingState")}
      data-testid="reading-state-select"
    >
      <option value="" disabled>
        {t("paper.noState")}
      </option>
      {READING_STATES.map((state) => (
        <option key={state} value={state}>
          {t(`paper.states.${state}`)}
        </option>
      ))}
    </select>
  );
}
