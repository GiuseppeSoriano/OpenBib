import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";

const OPTIONS: { value: ThemePreference; icon: typeof Sun; labelKey: string }[] = [
  { value: "light", icon: Sun, labelKey: "settings.themeLight" },
  { value: "dark", icon: Moon, labelKey: "settings.themeDark" },
  { value: "system", icon: Monitor, labelKey: "settings.themeSystem" },
];

/** Segmented Light | Dark | System control — used on the Settings page. */
export default function ThemeSegment() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();

  return (
    <div className="segmented" role="group" aria-label={t("common.theme")} data-testid="theme-segment">
      {OPTIONS.map(({ value, icon: Icon, labelKey }) => (
        <button
          key={value}
          type="button"
          className={preference === value ? "active" : ""}
          aria-pressed={preference === value}
          onClick={() => setPreference(value)}
        >
          <Icon size={13} className="theme-segment-icon" />
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
