import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  /** Small-caps line above the title (a date, "Collection", "Citation graph"). */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Buttons or figures on the right; they wrap below the title when narrow. */
  actions?: ReactNode;
  titleId?: string;
  /** Larger display title (the dashboard greeting). */
  display?: boolean;
  className?: string;
}

/** The page's h1 block: eyebrow, serif title, description and actions. */
export default function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  titleId,
  display = false,
  className,
}: PageHeaderProps) {
  const classes = ["page-header", display && "page-header--display", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <div className="page-header-text">
        {eyebrow && <p className="page-header-eyebrow">{eyebrow}</p>}
        <h1 id={titleId} className="page-header-title">
          {title}
        </h1>
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
