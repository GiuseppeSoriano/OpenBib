import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, GitFork, BookMarked, LogIn } from "lucide-react";
import Logo from "@/components/ui/Logo";
import "./LandingPage.css";

export default function LandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      navigate(`/search?q=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <div className="landing">
      <div className="landing-hero">
        <Logo size={64} className="landing-logo" />
        <h1 className="landing-title">OpenBib</h1>
        <p className="landing-tagline">{t("landing.tagline")}</p>

        <form onSubmit={handleSearch} className="landing-search">
          <div className="landing-search-wrap">
            <Search size={18} className="landing-search-icon" />
            <input
              className="input landing-search-input"
              type="text"
              placeholder={t("landing.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn-primary">
            {t("search.submit")}
          </button>
        </form>

        <p className="landing-hint">{t("landing.hint")}</p>

        <div className="landing-ctas">
          <Link to="/register" className="btn btn-primary">
            {t("auth.createAccount")}
          </Link>
          <Link to="/login" className="btn btn-secondary">
            <LogIn size={14} />
            {t("auth.signIn")}
          </Link>
        </div>
      </div>

      <div className="landing-features">
        <div className="card landing-feature">
          <Search size={22} />
          <h3>{t("landing.featureSearchTitle")}</h3>
          <p>{t("landing.featureSearchDesc")}</p>
        </div>
        <div className="card landing-feature">
          <GitFork size={22} />
          <h3>{t("landing.featureGraphTitle")}</h3>
          <p>{t("landing.featureGraphDesc")}</p>
        </div>
        <div className="card landing-feature">
          <BookMarked size={22} />
          <h3>{t("landing.featureLibraryTitle")}</h3>
          <p>{t("landing.featureLibraryDesc")}</p>
        </div>
      </div>
    </div>
  );
}
