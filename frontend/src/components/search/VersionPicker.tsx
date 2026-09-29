import { useMemo, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PaperMetadata } from "@/types";
import { versionLabels } from "@/components/paper/versionLabel";
import "./VersionPicker.css";

interface VersionPickerProps {
  versions: PaperMetadata[];
  selectedKey: string;
  onSelect: (version: PaperMetadata) => void;
}

const NEXT_KEYS = ["ArrowRight", "ArrowDown"];
const PREVIOUS_KEYS = ["ArrowLeft", "ArrowUp"];

/**
 * Radio group for switching between grouped versions of the same paper.
 * Labels are sibling-aware, so every option has a distinct visible label and
 * accessible name. Arrow keys move the selection (roving tabindex).
 */
export default function VersionPicker({ versions, selectedKey, onSelect }: VersionPickerProps) {
  const { t, i18n } = useTranslation();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = useMemo(
    () => versionLabels(versions, t, i18n.language),
    [versions, t, i18n.language],
  );
  const selectedIndex = Math.max(
    0,
    versions.findIndex((version) => version.canonical_key === selectedKey),
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    if (NEXT_KEYS.includes(event.key)) next = (selectedIndex + 1) % versions.length;
    else if (PREVIOUS_KEYS.includes(event.key))
      next = (selectedIndex - 1 + versions.length) % versions.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = versions.length - 1;
    else return;
    const target = versions[next];
    if (!target) return;
    event.preventDefault();
    onSelect(target);
    buttons.current[next]?.focus();
  };

  return (
    <div
      className="version-picker"
      role="radiogroup"
      aria-label={t("paper.versionsLabel")}
      data-testid="version-picker"
      onKeyDown={handleKeyDown}
    >
      {versions.map((version, index) => {
        const selected = version.canonical_key === selectedKey;
        const info = labels.get(version.canonical_key);
        return (
          <button
            key={version.canonical_key}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={info?.accessibleName}
            title={info?.accessibleName}
            tabIndex={index === selectedIndex ? 0 : -1}
            className={`pill pill--sm ${selected ? "active" : ""}`}
            onClick={() => onSelect(version)}
          >
            {info?.label}
          </button>
        );
      })}
    </div>
  );
}
