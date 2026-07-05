import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, GitFork, BookMarked } from "lucide-react";
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
        <Logo size={52} className="landing-logo" />
        <h1 className="landing-title">OpenBib</h1>
        <p className="landing-tagline">{t("landing.tagline")}</p>

        <form onSubmit={handleSearch} className="landing-search" role="search">
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
          <button type="submit" className="btn btn-primary landing-search-btn">
            {t("search.submit")}
          </button>
        </form>

        <p className="landing-hint">{t("landing.hint")}</p>

        <div className="landing-ctas">
          <Link to="/register" className="btn btn-primary">
            {t("auth.createAccount")}
          </Link>
          <Link to="/login" className="btn btn-secondary">
            {t("auth.signIn")}
          </Link>
        </div>
      </div>

      <div className="landing-features">
        <div className="landing-feature">
          <span className="landing-feature-icon">
            <Search size={18} />
          </span>
          <h3>{t("landing.featureSearchTitle")}</h3>
          <p>{t("landing.featureSearchDesc")}</p>
        </div>
        <div className="landing-feature">
          <span className="landing-feature-icon">
            <GitFork size={18} />
          </span>
          <h3>{t("landing.featureGraphTitle")}</h3>
          <p>{t("landing.featureGraphDesc")}</p>
        </div>
        <div className="landing-feature">
          <span className="landing-feature-icon">
            <BookMarked size={18} />
          </span>
          <h3>{t("landing.featureLibraryTitle")}</h3>
          <p>{t("landing.featureLibraryDesc")}</p>
        </div>
      </div>
    </div>
  );
}
