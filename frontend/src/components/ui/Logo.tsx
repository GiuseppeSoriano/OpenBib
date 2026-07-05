interface LogoProps {
  size?: number;
  className?: string;
}

/** OpenBib mark: a flat geometric open book — two mirrored pages. */
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
      <path d="M15 7.1C11.9 5.4 8.2 4.6 4 4.6v20.1c4.2 0 7.9.8 11 2.5V7.1Z" />
      <path d="M17 7.1c3.1-1.7 6.8-2.5 11-2.5v20.1c-4.2 0-7.9.8-11 2.5V7.1Z" />
    </svg>
  );
}
