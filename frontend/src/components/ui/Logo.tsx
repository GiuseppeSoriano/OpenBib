interface LogoProps {
  size?: number;
  className?: string;
}

/** OpenBib mark: "Folio" — three pages fanning open from a spine.
 * Stroke-based, round terminals; inherits color via currentColor. */
export default function Logo({ size = 24, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.5}
      strokeLinecap="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="OpenBib"
    >
      <path d="M7.5 26V7" />
      <path d="M7.5 26L17.5 9.5" />
      <path d="M7.5 26L25.5 14" />
    </svg>
  );
}
