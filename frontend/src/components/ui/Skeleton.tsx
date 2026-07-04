interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  /** Render N stacked lines. */
  lines?: number;
}

export default function Skeleton({ width, height = "1rem", className, lines = 1 }: SkeletonProps) {
  if (lines > 1) {
    return (
      <div className="skeleton-group" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className={`skeleton ${className ?? ""}`}
            style={{ width: i === lines - 1 ? "60%" : (width ?? "100%"), height }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      className={`skeleton ${className ?? ""}`}
      style={{ width: width ?? "100%", height }}
      aria-hidden="true"
    />
  );
}

/** Card-shaped skeleton block for list placeholders. */
export function SkeletonCard({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-cards" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton-card">
          <Skeleton height="1.1rem" width="70%" />
          <Skeleton height="0.85rem" lines={2} />
        </div>
      ))}
    </div>
  );
}
