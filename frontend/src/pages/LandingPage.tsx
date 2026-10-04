import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import SectionHeading from "@/components/ui/SectionHeading";
import "./LandingPage.css";

const FEATURES = ["Search", "Graph", "Library"] as const;

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
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="landing-eyebrow">OpenBib</p>
        <h1 id="landing-title" className="landing-title">
          {t("landing.tagline")}
        </h1>
        <p className="landing-lede">{t("landing.lede")}</p>

        <form onSubmit={handleSearch} className="landing-search" role="search">
          <label htmlFor="landing-query" className="sr-only">
            {t("search.queryLabel")}
          </label>
          <div className="landing-field">
            <Search size={18} className="landing-field-icon" aria-hidden="true" />
            <input
              id="landing-query"
              className="landing-field-input"
              type="search"
              placeholder={t("landing.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-keyshortcuts="/"
              autoFocus
            />
            <kbd className="landing-field-kbd" aria-hidden="true">
              /
            </kbd>
          </div>
          <button type="submit" className="btn btn-primary landing-search-btn">
            {t("search.submit")}
          </button>
        </form>

        <div className="landing-account">
          <p className="landing-hint">{t("landing.hint")}</p>
          <div className="landing-ctas">
            <Link to="/register" className="btn btn-secondary">
              {t("auth.createAccount")}
            </Link>
            <Link to="/login" className="btn btn-secondary">
              {t("auth.signIn")}
            </Link>
          </div>
        </div>
      </section>

      <section className="landing-features" aria-labelledby="landing-features-title">
        <SectionHeading id="landing-features-title" title={t("landing.featuresTitle")} />
        <ol className="list-rows landing-feature-list">
          {FEATURES.map((feature, index) => (
            <li key={feature} className="list-row landing-feature">
              <span className="landing-feature-num tabular" aria-hidden="true">
                {index + 1}
              </span>
              <h3 className="landing-feature-title">{t(`landing.feature${feature}Title`)}</h3>
              <p className="landing-feature-desc">{t(`landing.feature${feature}Desc`)}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
