import type { ReactNode } from "react";

interface SectionHeadingProps {
  title: ReactNode;
  /** Id for the heading, so a <section aria-labelledby> can point at it. */
  id?: string;
  level?: 2 | 3;
  /** Right-aligned link or quiet action ("View all →"). */
  action?: ReactNode;
  className?: string;
}

/** A serif section title over a 1px ink rule, with an optional action. */
export default function SectionHeading({
  title,
  id,
  level = 2,
  action,
  className,
}: SectionHeadingProps) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className={className ? `section-heading ${className}` : "section-heading"}>
      <Heading id={id} className="section-heading-title">
        {title}
      </Heading>
      {action && <div className="section-heading-action">{action}</div>}
    </div>
  );
}
