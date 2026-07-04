interface LogoProps {
  size?: number;
  className?: string;
}

/** OpenBib mark: an open book budding into citation-graph nodes. */
export default function Logo({ size = 28, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="OpenBib"
    >
      <path
        d="M16 27c-2.6-1.9-6.1-2.9-10-2.9V10.5c3.9 0 7.4 1 10 2.9 2.6-1.9 6.1-2.9 10-2.9v13.6c-3.9 0-7.4 1-10 2.9Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M16 13.4V27" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M16 12.6V9.8M14.3 7.1 10.3 5.3M17.7 7.1l4-1.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="16" cy="7.9" r="2" fill="currentColor" />
      <circle cx="8.9" cy="4.7" r="1.5" fill="currentColor" />
      <circle cx="23.1" cy="4.7" r="1.5" fill="currentColor" />
    </svg>
  );
}
