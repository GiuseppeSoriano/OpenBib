import { useTranslation } from "react-i18next";
import type { PaperMetadata } from "@/types";
import { versionLabel } from "@/components/paper/versionLabel";

interface VersionPickerProps {
  versions: PaperMetadata[];
  selectedKey: string;
  onSelect: (version: PaperMetadata) => void;
}

/** Chip row for switching between grouped versions of the same paper. */
export default function VersionPicker({ versions, selectedKey, onSelect }: VersionPickerProps) {
  const { t } = useTranslation();

  return (
    <div className="version-picker" data-testid="version-picker">
      {versions.map((version) => (
        <button
          key={version.canonical_key}
          type="button"
          className={`pill pill--sm ${version.canonical_key === selectedKey ? "active" : ""}`}
          aria-pressed={version.canonical_key === selectedKey}
          onClick={() => onSelect(version)}
        >
          {versionLabel(version, t)}
        </button>
      ))}
    </div>
  );
}
