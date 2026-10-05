import { useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { maxSearchYear, MIN_SEARCH_YEAR, parseYear, type SearchParamsState } from "@/lib/searchParams";
import type { YearPatch } from "@/components/search/yearRange";

const yearText = (year: number | undefined) => (year === undefined ? "" : String(year));

export interface YearDrafts {
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  error: string | null;
  /** The typed years, validated; null (with the error shown) when invalid. */
  read: () => YearPatch | null;
  /** Typed years that differ from the applied ones; {} when there are none. */
  pending: () => YearPatch | null;
  /** The fields differ from the applied years. */
  dirty: boolean;
  /** Puts these years in the fields (a preset, Clear). */
  set: (years: YearPatch) => void;
}

/**
 * Typed years stay local until applied (Apply, Enter, or any other search or
 * filter change); they follow the URL when it changes (back/forward, reset)
 * without clobbering unapplied input otherwise.
 */
export function useYearDrafts(params: SearchParamsState, onInvalid: () => void): YearDrafts {
  const { t } = useTranslation();
  const applied = `${yearText(params.year_from)}-${yearText(params.year_to)}`;
  const [synced, setSynced] = useState(applied);
  const [from, setFrom] = useState(yearText(params.year_from));
  const [to, setTo] = useState(yearText(params.year_to));
  const [error, setError] = useState<string | null>(null);
  if (applied !== synced) {
    setSynced(applied);
    setFrom(yearText(params.year_from));
    setTo(yearText(params.year_to));
    setError(null);
  }

  const read = (): YearPatch | null => {
    const fromYear = from.trim() ? parseYear(from) : undefined;
    const toYear = to.trim() ? parseYear(to) : undefined;
    let message: string | null = null;
    if ((from.trim() && fromYear === undefined) || (to.trim() && toYear === undefined)) {
      message = t("search.yearInvalid", { min: MIN_SEARCH_YEAR, max: maxSearchYear() });
    } else if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
      message = t("errors.invalid_year_range");
    }
    setError(message);
    if (!message) return { year_from: fromYear, year_to: toYear };
    onInvalid();
    return null;
  };

  const dirty = `${from.trim()}-${to.trim()}` !== applied;
  const pending = (): YearPatch | null => {
    if (dirty) return read();
    setError(null);
    return {};
  };

  const set = (years: YearPatch) => {
    setFrom(yearText(years.year_from));
    setTo(yearText(years.year_to));
    setError(null);
  };

  return { from, to, setFrom, setTo, error, read, pending, dirty, set };
}

interface YearFieldsProps {
  /** Prefix for the field ids (unique per surface). */
  id: string;
  drafts: YearDrafts;
  fromRef?: Ref<HTMLInputElement>;
}

/** From – To year inputs with the shared validation message. */
export default function YearFields({ id, drafts, fromRef }: YearFieldsProps) {
  const { t } = useTranslation();
  const errorId = `${id}-year-error`;
  const invalid = drafts.error ? true : undefined;
  const describedBy = drafts.error ? errorId : undefined;

  return (
    <>
      <div className="search-years-row">
        <div className="search-years-field">
          <label htmlFor={`${id}-from`}>{t("search.yearFrom")}</label>
          <input
            id={`${id}-from`}
            ref={fromRef}
            type="number"
            inputMode="numeric"
            className="input input--numeric"
            min={MIN_SEARCH_YEAR}
            max={maxSearchYear()}
            value={drafts.from}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => drafts.setFrom(event.target.value)}
          />
        </div>
        <span className="search-years-dash" aria-hidden="true">
          –
        </span>
        <div className="search-years-field">
          <label htmlFor={`${id}-to`}>{t("search.yearTo")}</label>
          <input
            id={`${id}-to`}
            type="number"
            inputMode="numeric"
            className="input input--numeric"
            min={MIN_SEARCH_YEAR}
            max={maxSearchYear()}
            value={drafts.to}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => drafts.setTo(event.target.value)}
          />
        </div>
      </div>
      {drafts.error && (
        <p id={errorId} className="search-years-error" role="alert">
          {drafts.error}
        </p>
      )}
    </>
  );
}
