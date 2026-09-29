import { useTranslation } from "react-i18next";
import type { CitingOrder, RelationDirection } from "@/types";

interface Option<T extends string> {
  value: T;
  label: string;
  title: string;
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented graph-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "active" : ""}
          aria-pressed={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Citers vs. references of the selected paper; applies immediately. */
export function DirectionToggle({
  value,
  onChange,
}: {
  value: RelationDirection;
  onChange: (value: RelationDirection) => void;
}) {
  const { t } = useTranslation();
  return (
    <Segmented
      label={t("graph.direction")}
      value={value}
      onChange={onChange}
      options={[
        { value: "cited_by", label: t("graph.citers"), title: t("graph.citersTitle") },
        { value: "cites", label: t("graph.references"), title: t("graph.referencesTitle") },
      ]}
    />
  );
}

/** Ranking of the related list; applies immediately. */
export function OrderingToggle({
  value,
  onChange,
}: {
  value: CitingOrder;
  onChange: (value: CitingOrder) => void;
}) {
  const { t } = useTranslation();
  return (
    <Segmented
      label={t("graph.ordering")}
      value={value}
      onChange={onChange}
      options={[
        { value: "cited_by_count", label: t("graph.topCited"), title: t("graph.topCitedTitle") },
        { value: "recent", label: t("graph.mostRecent"), title: t("graph.mostRecentTitle") },
      ]}
    />
  );
}
