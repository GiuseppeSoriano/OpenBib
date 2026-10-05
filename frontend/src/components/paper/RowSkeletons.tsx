import Skeleton from "@/components/ui/Skeleton";

/** Row-shaped placeholders for the hairline lists (Library, collections). */
export default function RowSkeletons({ count = 3 }: { count?: number }) {
  return (
    <ul className="list-rows list-rows--ruled" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="list-row skeleton-card">
          <Skeleton height="1.1rem" width="70%" />
          <Skeleton height="0.85rem" lines={2} />
        </li>
      ))}
    </ul>
  );
}
