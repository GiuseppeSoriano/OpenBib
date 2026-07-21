interface LogoProps {
  size?: number;
  className?: string;
}

/** OpenBib mark: a flat open book — two mirrored pages with soft,
 * continuous curves and rounded outer corners. */
export default function Logo({ size = 24, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="OpenBib"
    >
      <path d="M15 6.6C12.4 5.1 9.5 4.3 6.5 4.1 5.1 4 4 5.1 4 6.5v16.7c0 1.3 1 2.4 2.3 2.5 3.1.2 6.1 1 8.7 2.5V6.6Z" />
      <path d="M17 6.6c2.6-1.5 5.5-2.3 8.5-2.5 1.4-.1 2.5 1 2.5 2.4v16.7c0 1.3-1 2.4-2.3 2.5-3.1.2-6.1 1-8.7 2.5V6.6Z" />
    </svg>
  );
}
