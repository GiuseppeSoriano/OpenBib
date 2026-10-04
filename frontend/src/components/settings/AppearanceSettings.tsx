import { useId, useRef, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { useHashFocus } from "@/hooks/useHashFocus";
import SettingsSection, { SettingsRow } from "./SettingsSection";

export const THEME_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" },
];

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "it", label: "Italiano" },
] as const;

export type Language = (typeof LANGUAGES)[number]["value"];

export function currentLanguage(resolved: string | undefined): Language {
  return resolved?.startsWith("it") ? "it" : "en";
}

/**
 * Appearance (`#appearance`): theme preview cards and the interface language
 * (`#language`). The phone drill-in shows each one as its own section.
 */
export default function AppearanceSettings({ part = "all" }: { part?: "all" | "theme" | "language" }) {
  const { t } = useTranslation();
  if (part === "language") {
    return (
      <SettingsSection id="language" title={t("settings.language")}>
        <LanguageRow />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection id="appearance" title={t("settings.appearance")}>
      <ThemeRow />
      {part === "all" && <LanguageRow anchored />}
    </SettingsSection>
  );
}

function ThemeRow() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const helpId = useId();
  const groupRef = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    setPreference(THEME_OPTIONS[index]!.value);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus();
  };

  // A radio group: one tab stop, arrows move and select, Home/End jump.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = THEME_OPTIONS.length;
    const current = THEME_OPTIONS.findIndex((option) => option.value === preference);
    const keys: Record<string, number> = {
      ArrowRight: (current + 1) % count,
      ArrowDown: (current + 1) % count,
      ArrowLeft: (current - 1 + count) % count,
      ArrowUp: (current - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    select(keys[event.key]!);
  };

  return (
    <SettingsRow label={t("common.theme")} description={t("settings.themeHelp")} descriptionId={helpId}>
      <div
        ref={groupRef}
        className="settings-theme-cards"
        role="radiogroup"
        aria-label={t("common.theme")}
        aria-describedby={helpId}
        data-testid="theme-segment"
        onKeyDown={onKeyDown}
      >
        {THEME_OPTIONS.map(({ value, labelKey }, index) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={preference === value}
            tabIndex={preference === value ? 0 : -1}
            className="settings-theme-card"
            onClick={() => select(index)}
          >
            <span className={`settings-theme-preview settings-theme-preview--${value}`} aria-hidden="true" />
            {t(labelKey)}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}

function LanguageRow({ anchored = false }: { anchored?: boolean }) {
  const { t, i18n } = useTranslation();
  const helpId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <SettingsRow
      label={t("settings.language")}
      description={t("settings.languageHelp")}
      descriptionId={helpId}
      id={anchored ? "language" : undefined}
      rowRef={anchored ? rowRef : undefined}
    >
      <SegmentedControl
        label={t("common.language")}
        value={currentLanguage(i18n.resolvedLanguage)}
        options={LANGUAGES.map(({ value, label }) => ({ value, label }))}
        onChange={(value) => void i18n.changeLanguage(value)}
        className="settings-language"
        testId="language-segment"
      />
      {anchored && <LanguageAnchor target={rowRef} />}
    </SettingsRow>
  );
}

/** `/settings#language` lands on the language row inside Appearance. */
function LanguageAnchor({ target }: { target: RefObject<HTMLDivElement> }) {
  useHashFocus("language", target);
  return null;
}
