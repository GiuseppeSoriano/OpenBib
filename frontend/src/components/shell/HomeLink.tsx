import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Logo from "@/components/ui/Logo";

/** The OpenBib mark linking home, for full-screen pages without the app shell (graph header). */
export default function HomeLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Link to="/" className={`shell-home-link${className ? ` ${className}` : ""}`} aria-label={t("shell.home")}>
      <Logo size={22} className="shell-home-logo" />
    </Link>
  );
}
