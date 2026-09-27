import { useTranslation } from "react-i18next";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";

const ORDER: ThemePreference[] = ["light", "dark", "system"];

const ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

const LABEL_KEYS = {
  light: "settings.themeLight",
  dark: "settings.themeDark",
  system: "settings.themeSystem",
} as const;

/** Cycles light → dark → system. */
export default function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const Icon = ICONS[preference];
  const label = t("common.themeCurrent", { value: t(LABEL_KEYS[preference]) });

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!;
    setPreference(next);
  };

  return (
    <button
      type="button"
      className={`btn-ghost theme-toggle ${className ?? ""}`}
      onClick={cycle}
      title={label}
      aria-label={label}
      data-testid="theme-toggle"
    >
      <Icon size={18} />
    </button>
  );
}
