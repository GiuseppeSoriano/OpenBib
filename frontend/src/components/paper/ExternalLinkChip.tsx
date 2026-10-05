import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { linkHost } from "@/components/paper/links";

interface ExternalLinkChipProps {
  href: string;
  /** Optional leading icon (decorative). */
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * A link chip that opens in a new tab and says so: a visible external glyph,
 * screen-reader text, and the destination host as its tooltip.
 */
export default function ExternalLinkChip({ href, icon, children }: ExternalLinkChipProps) {
  const { t } = useTranslation();
  return (
    <a
      className="link-chip"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={linkHost(href) || undefined}
    >
      {icon}
      {children}
      <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only">{` ${t("common.opensInNewTab")}`}</span>
    </a>
  );
}
