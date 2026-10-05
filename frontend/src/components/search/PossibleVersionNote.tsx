import { useTranslation } from "react-i18next";
import { resultElementId } from "@/lib/search-pages";
import type { PossibleVersion } from "@/types";
import "./PossibleVersionNote.css";

interface Props {
  versions: PossibleVersion[];
  /** Whether a result is on screen; Show is offered only for those. */
  isShown: (groupKey: string) => boolean;
  /** Called after the related card is scrolled to and focused (to highlight it). */
  onShow: (groupKey: string) => void;
}

/** Scrolls to the result card of `groupKey` and moves keyboard focus to it. */
function revealResult(groupKey: string): boolean {
  const card = document.getElementById(resultElementId(groupKey));
  if (!card) return false;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView?.({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  card.focus({ preventScroll: true });
  return true;
}

/**
 * S04: results that look like another version of this one (similar title,
 * authors and year) but were not merged. Show jumps to the related card.
 */
export default function PossibleVersionNote({ versions, isShown, onShow }: Props) {
  const { t } = useTranslation();
  if (versions.length === 0) return null;

  return (
    <div className="possible-version">
      {versions.map((version) => (
        <p key={version.paper_group_key} className="possible-version-row">
          <span className="possible-version-label">{t("search.possibleOtherVersion")}</span>{" "}
          <span className="possible-version-title">{version.title}</span>
          {isShown(version.paper_group_key) && (
            <button
              type="button"
              className="btn-ghost possible-version-show"
              aria-label={t("search.showRelatedNamed", { title: version.title })}
              onClick={() => {
                if (revealResult(version.paper_group_key)) onShow(version.paper_group_key);
              }}
            >
              {t("search.showRelated")}
            </button>
          )}
        </p>
      ))}
      <p className="possible-version-hint">{t("search.possibleOtherVersionHint")}</p>
    </div>
  );
}
