import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import api from "@/lib/api";
import { apiStatus } from "@/lib/apiError";
import { parseIdentifier } from "@/lib/identifiers";
import { useApiErrorText } from "@/hooks/useApiErrorText";
import { useToast } from "@/components/ui/Toast";
import AnnouncedText from "@/components/ui/AnnouncedText";
import type { CollectionPaper } from "@/types";
import "./CollectionPaperForms.css";

interface AddPaperFormProps {
  collectionId: string;
  /** A 403/404: the user's access changed while the page was open. */
  onAccessError: () => void;
}

/**
 * Add one paper by DOI (or arXiv ID, PMID, Semantic Scholar link). Input the
 * server would reject is caught before any request; server errors stay
 * inline next to the field, with a Retry-After wait counted down.
 */
export default function AddPaperForm({ collectionId, onAccessError }: AddPaperFormProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { text: errorText, announcement, waiting } = useApiErrorText(error, t("collections.addPaperFailed"));
  const message = invalid ? t("errors.invalid_identifier") : errorText;

  const add = useMutation({
    mutationFn: async (identifier: string) =>
      (
        await api.post<CollectionPaper>(`/collections/${collectionId}/papers`, {
          paper_canonical_key: identifier,
        })
      ).data,
    onSuccess: (row) => {
      setValue("");
      if (row?.resolved === false) toast(t("collections.addPaperPending"), "info");
      else toast(t("collections.addPaperSuccess", { title: row?.paper?.title ?? t("collections.thisPaper") }), "success");
      for (const queryKey of [
        ["collection-papers", collectionId],
        ["collection", collectionId],
        ["library-entries"],
        ["library-keys"],
        ["library-facets"],
        ["paper-memberships"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (err: unknown) => {
      const status = apiStatus(err);
      if (status === 403 || status === 404) {
        onAccessError();
        return;
      }
      setError(err);
      inputRef.current?.focus();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const identifier = value.trim();
    if (!identifier || add.isPending) return;
    setError(null);
    if (!parseIdentifier(identifier)) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    setInvalid(false);
    add.mutate(identifier);
  }

  return (
    <form className="cd-add-form" onSubmit={submit} noValidate aria-busy={add.isPending || undefined}>
      <label htmlFor={inputId} className="cd-add-label">
        {t("collections.addPaperLabel")}
      </label>
      <div className="cd-add-row">
        <input
          id={inputId}
          ref={inputRef}
          className="input"
          value={value}
          placeholder={t("collections.addPaperPlaceholder")}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
            setError(null);
          }}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${errorId} ${hintId}` : hintId}
          maxLength={512}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary" disabled={!value.trim() || add.isPending || waiting}>
          <Plus size={14} aria-hidden="true" />
          {add.isPending ? t("collections.adding") : t("collections.addPaper")}
        </button>
      </div>
      <p id={hintId} className="cd-add-hint">
        {t("collections.addPaperHint")}
      </p>
      {message && (
        <p id={errorId} className="cd-add-error" role="alert">
          <AnnouncedText text={message} announcement={invalid ? null : announcement} />
        </p>
      )}
    </form>
  );
}
