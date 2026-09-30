interface AnnouncedTextProps {
  /** What is shown; may change while it is on screen (a countdown). */
  text: string;
  /** What assistive tech reads instead, once; null when `text` is stable. */
  announcement?: string | null;
}

/**
 * Text for a live region whose visible copy ticks (a Retry-After countdown):
 * screen readers get the stable `announcement` once, not a new alert every
 * second. Keep the same `announcement` for as long as the wait is shown.
 */
export default function AnnouncedText({ text, announcement = null }: AnnouncedTextProps) {
  if (announcement === null) return <>{text}</>;
  return (
    <>
      <span className="sr-only">{announcement}</span>
      <span aria-hidden="true">{text}</span>
    </>
  );
}
