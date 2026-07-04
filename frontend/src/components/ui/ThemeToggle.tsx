import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";

const ORDER: ThemePreference[] = ["light", "dark", "system"];

const ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

/** Cycles light → dark → system. */
export default function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  const Icon = ICONS[preference];

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!;
    setPreference(next);
  };

  return (
    <button
      type="button"
      className={`btn-ghost theme-toggle ${className ?? ""}`}
      onClick={cycle}
      title={`Theme: ${preference}`}
      aria-label={`Theme: ${preference}`}
      data-testid="theme-toggle"
    >
      <Icon size={18} />
    </button>
  );
}
