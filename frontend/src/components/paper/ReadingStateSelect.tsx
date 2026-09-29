import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { papers } from "@/lib/api";
import { READING_STATES, type ReadingState } from "@/types";

/** Select bound to the per-version reading state endpoints. */
export default function ReadingStateSelect({ paperKey }: { paperKey: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: states } = useQuery({
    queryKey: ["paper-states", paperKey],
    queryFn: () => papers.getStates(paperKey),
  });

  const mutation = useMutation({
    mutationFn: (state: ReadingState) => papers.setState(paperKey, state),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["paper-states", paperKey] });
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
