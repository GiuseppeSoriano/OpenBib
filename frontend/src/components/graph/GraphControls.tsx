import { useTranslation } from "react-i18next";
import SegmentedControl from "@/components/ui/SegmentedControl";
import type { CitingOrder, RelationDirection } from "@/types";

interface ToggleProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  /** Stretch to the container (the compact sheet). */
  block?: boolean;
}

/** Citers vs. references of the selected paper; applies immediately. */
export function DirectionToggle({ value, onChange, block }: ToggleProps<RelationDirection>) {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      label={t("graph.direction")}
      value={value}
      onChange={onChange}
      block={block}
      className="graph-segmented"
      options={[
        { value: "cited_by", label: t("graph.citers"), title: t("graph.citersTitle") },
        { value: "cites", label: t("graph.references"), title: t("graph.referencesTitle") },
      ]}
    />
  );
}

/** Ranking of the related list; applies immediately. */
export function OrderingToggle({ value, onChange, block }: ToggleProps<CitingOrder>) {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      label={t("graph.ordering")}
      value={value}
      onChange={onChange}
      block={block}
      className="graph-segmented"
      options={[
        { value: "cited_by_count", label: t("graph.topCited"), title: t("graph.topCitedTitle") },
        { value: "recent", label: t("graph.mostRecent"), title: t("graph.mostRecentTitle") },
      ]}
    />
  );
}
