import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional tooltip, e.g. a longer explanation of a terse label. */
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  /** Accessible name of the radio group. */
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  /** Stretch to the container's width (sheets, narrow columns). */
  block?: boolean;
  className?: string;
  testId?: string;
  /** Id of a hint that describes the group (aria-describedby). */
  describedBy?: string;
}

/**
 * A segmented radio group: one tab stop (the checked segment), arrow keys
 * move and select, Home/End jump to the ends, disabled segments are skipped.
 */
export default function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  block = false,
  className,
  testId,
  describedBy,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const enabled = options.filter((option) => !option.disabled);
  const checkedIndex = options.findIndex((option) => option.value === value);
  // With no (enabled) checked segment, the first enabled one is the tab stop.
  const tabStop =
    checkedIndex !== -1 && !options[checkedIndex]!.disabled ? value : enabled[0]?.value;

  const select = (next: T) => {
    if (next !== value) onChange(next);
    const index = options.findIndex((option) => option.value === next);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((option) => option.value === value);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = current === -1 ? 0 : (current + 1) % enabled.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = current === -1 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(enabled[next]!.value);
  };

  const classes = ["segmented", block && "segmented--block", className].filter(Boolean).join(" ");

  return (
    <div
      ref={groupRef}
      className={classes}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={option.value === tabStop ? 0 : -1}
            title={option.title}
            disabled={option.disabled}
            onClick={() => select(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
