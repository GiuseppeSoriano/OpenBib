import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { papers } from "@/lib/api";
import { apiErrorText } from "@/lib/apiError";
import { MenuChip } from "@/components/ui/Chip";
import Popover, { PopoverListbox, type ListboxOption } from "@/components/ui/Popover";
import { useToast } from "@/components/ui/Toast";
import { READING_STATES, type PaperState, type ReadingState } from "@/types";
import "./ReadingStateSelect.css";

/** The state's colour mark; the label beside it carries the meaning. */
function StateDot({ state }: { state: ReadingState | "" }) {
  return <span className={`state-dot state-dot--${state || "none"}`} aria-hidden="true" />;
}

/**
 * Reading-state chip bound to the per-version reading state endpoints: it
 * opens a listbox popover and saves the choice optimistically. `fromList`:
 * a row of a list whose response seeds this query and keeps it fresh, so the
 * row never refetches by itself (a long list would cost a request per row).
 */
export default function ReadingStateSelect({
  paperKey,
  fromList = false,
}: {
  paperKey: string;
  fromList?: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["paper-states", paperKey];

  const { data: states } = useQuery({
    queryKey,
    queryFn: () => papers.getStates(paperKey),
    ...(fromList ? { staleTime: Infinity } : {}),
  });

  const mutation = useMutation({
    mutationFn: (state: ReadingState) => papers.setState(paperKey, state),
    onMutate: async (state) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<PaperState[]>(queryKey);
      queryClient.setQueryData<PaperState[]>(queryKey, [{ paper_canonical_key: paperKey, state }]);
      return { previous };
    },
    onSuccess: (saved) => {
      // States are per exact key, so the saved row is the whole list: no refetch.
      queryClient.setQueryData<PaperState[]>(queryKey, [saved]);
      // State-filtered Library pages and the state facets.
      void queryClient.invalidateQueries({ queryKey: ["library-entries"] });
    },
    onError: (err, _state, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      else void queryClient.invalidateQueries({ queryKey });
      toast(apiErrorText(err, t, t("paper.stateFailed")), "error");
    },
  });

  const current: ReadingState | "" =
    states?.find((s) => s.paper_canonical_key === paperKey)?.state ?? "";
  const currentLabel = current ? t(`paper.states.${current}`) : t("paper.noState");
  const pending = mutation.isPending;

  const options: ListboxOption<ReadingState>[] = READING_STATES.map((state) => ({
    value: state,
    label: (
      <span className="state-option">
        <StateDot state={state} />
        {t(`paper.states.${state}`)}
      </span>
    ),
  }));

  return (
    <Popover
      haspopup="listbox"
      className="reading-state-popover"
      testId="reading-state-popover"
      reveal
      trigger={({ onClick, ...props }) => (
        <MenuChip
          {...props}
          className="state-chip"
          data-state={current || "none"}
          data-testid="reading-state-select"
          aria-label={t("paper.readingStateValue", { state: currentLabel })}
          // Stays focusable while saving (aria-disabled), so focus is not lost.
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          onClick={pending ? undefined : onClick}
          // Like a select: the arrow keys open the list on the current state.
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            if (!pending && !props["aria-expanded"]) onClick();
          }}
        >
          <StateDot state={current} />
          <span className="state-chip-label">{currentLabel}</span>
        </MenuChip>
      )}
    >
      {(close) => (
        <PopoverListbox<ReadingState | "">
          label={t("paper.readingState")}
          options={options}
          value={current}
          onSelect={(next) => {
            close();
            if (next && next !== current && !mutation.isPending) mutation.mutate(next);
          }}
        />
      )}
    </Popover>
  );
}
