import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

interface ChipProps {
  children: ReactNode;
  /** Shows a remove button with this accessible name (e.g. "Remove filter: 2019–2023"). */
  removeLabel?: string;
  onRemove?: () => void;
  active?: boolean;
  className?: string;
}

/** A static tag (an active filter, a keyword); optionally removable. */
export function Chip({ children, removeLabel, onRemove, active, className }: ChipProps) {
  const removable = Boolean(onRemove && removeLabel);
  return (
    <span className={classes("chip", removable && "chip--static", active && "chip--active", className)}>
      <span>{children}</span>
      {removable && (
        <button type="button" className="chip-remove" aria-label={removeLabel} onClick={onRemove}>
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children">;

interface FilterChipProps extends Omit<ButtonProps, "onChange"> {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
  /** Optional count, in tabular figures ("Filters · 3"). */
  count?: number;
}

/** A toggle chip ("Open access", "Hide dismissed"): aria-pressed carries the state. */
export function FilterChip({
  pressed,
  onPressedChange,
  children,
  count,
  className,
  ...rest
}: FilterChipProps) {
  return (
    <button
      {...rest}
      type="button"
      className={classes("chip", className)}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
    >
      {children}
      {count !== undefined && <span className="chip-count">{count}</span>}
    </button>
  );
}

interface MenuChipProps extends Omit<ButtonProps, "prefix"> {
  children: ReactNode;
  /** Muted prefix before the value ("Sort" + "Most cited"). */
  prefix?: ReactNode;
  /** A non-default value is applied: accent styling. */
  active?: boolean;
}

/**
 * A chip that opens a popover ("Year ▾", "Sort ▾"). Pass it Popover's
 * trigger props: `trigger={(props) => <MenuChip {...props}>…</MenuChip>}`.
 */
export const MenuChip = forwardRef<HTMLButtonElement, MenuChipProps>(function MenuChip(
  { children, prefix, active, className, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      className={classes("chip", active && "chip--active", className)}
    >
      {prefix !== undefined && <span className="chip-prefix">{prefix}</span>}
      {children}
      <ChevronDown size={12} strokeWidth={2.4} className="chip-caret" aria-hidden="true" />
    </button>
  );
});
