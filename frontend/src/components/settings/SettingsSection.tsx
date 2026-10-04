import { useId, useRef, type ReactNode, type RefObject } from "react";
import { useInRouterContext } from "react-router-dom";
import SectionHeading from "@/components/ui/SectionHeading";
import { useHashFocus } from "@/hooks/useHashFocus";

interface SettingsSectionProps {
  /** Anchor of the section: `/settings#<id>` scrolls to it and focuses it. */
  id: string;
  title: ReactNode;
  /** One line under the heading. */
  description?: ReactNode;
  /** Id of an element that describes the whole section. */
  describedBy?: string;
  /** Deep links wait for the section's content (default true). */
  ready?: boolean;
  /** Element a deep link focuses instead of the section, when it exists. */
  focus?: RefObject<HTMLElement>;
  danger?: boolean;
  testId?: string;
  children: ReactNode;
}

/** A settings section: serif heading over an ink rule, then hairline rows. */
export default function SettingsSection({
  id,
  title,
  description,
  describedBy,
  ready = true,
  focus,
  danger = false,
  testId,
  children,
}: SettingsSectionProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // Outside a router (isolated component tests) there is no hash to follow.
  const inRouter = useInRouterContext();

  return (
    <section
      id={id}
      ref={sectionRef}
      tabIndex={-1}
      className={danger ? "settings-section settings-section--danger" : "settings-section"}
      aria-labelledby={headingId}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      <SectionHeading id={headingId} title={title} />
      {description && <p className="settings-section-description">{description}</p>}
      {children}
      {inRouter && <HashFocus id={id} target={sectionRef} ready={ready} focus={focus} />}
    </section>
  );
}

function HashFocus({
  id,
  target,
  ready,
  focus,
}: {
  id: string;
  target: RefObject<HTMLElement>;
  ready: boolean;
  focus?: RefObject<HTMLElement>;
}) {
  useHashFocus(id, target, { ready, focus });
  return null;
}

interface SettingsRowProps {
  label: ReactNode;
  /** Makes the row label a <label> for this control. */
  labelFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  /** Anchor inside a section (`#language`). */
  id?: string;
  rowRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
}

/** Label and description on the left, the control on the right; stacks when narrow. */
export function SettingsRow({
  label,
  labelFor,
  description,
  descriptionId,
  id,
  rowRef,
  children,
}: SettingsRowProps) {
  return (
    <div className="settings-row" id={id} ref={rowRef} tabIndex={id ? -1 : undefined}>
      <div className="settings-row-text">
        {labelFor ? (
          <label className="settings-row-label" htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <p className="settings-row-label">{label}</p>
        )}
        {description && (
          <p className="settings-row-description" id={descriptionId}>
            {description}
          </p>
        )}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
