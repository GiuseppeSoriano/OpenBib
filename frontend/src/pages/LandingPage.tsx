import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CodeXml,
  Database,
  Download,
  FileInput,
  FolderOpen,
  LibraryBig,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import SectionHeading from "@/components/ui/SectionHeading";
import "./LandingPage.css";

/** Search terms, not UI copy: the indexed literature is mostly in English. */
const EXAMPLE_QUERIES = ["graph neural networks", "CRISPR gene editing", "climate adaptation", "10.1038/nature14539"];

const FEATURES: ReadonlyArray<{ key: string; icon: LucideIcon }> = [
  { key: "search", icon: Search },
  { key: "library", icon: LibraryBig },
  { key: "collections", icon: FolderOpen },
  { key: "graph", icon: Share2 },
  { key: "import", icon: FileInput },
  { key: "zotero", icon: RefreshCw },
];

const STEPS = ["search", "save", "explore"] as const;

const TRUST: ReadonlyArray<{ key: string; icon: LucideIcon }> = [
  { key: "source", icon: Database },
  { key: "openSource", icon: CodeXml },
  { key: "privacy", icon: ShieldCheck },
  { key: "yourData", icon: Download },
];

/* The hero motif: a small citation network drawn like the graph page (plain
   and pinned papers, the Library's centre mark, the selected paper's amber ring). */
type NodeKind = "plain" | "pinned";
// x, y, radius, kind, in the Library
const NET_NODES: ReadonlyArray<[number, number, number, NodeKind, boolean]> = [
  [62, 58, 6, "plain", false],
  [128, 30, 6, "plain", true],
  [236, 44, 7, "pinned", true],
  [290, 128, 5, "plain", false],
  [252, 214, 7, "plain", true],
  [150, 236, 5, "plain", false],
  [52, 186, 7, "pinned", false],
  [210, 128, 4, "plain", false],
  [98, 128, 4, "plain", false],
  [24, 112, 4, "plain", false],
  [300, 228, 4, "plain", false],
];
// The mark's share of the node radius, as on the graph canvas.
const MARK_SHARE = 0.4;
const NET_CENTER: [number, number] = [160, 130];
const NET_EDGES: ReadonlyArray<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 9],
  [9, 0],
  [2, 7],
  [6, 8],
  [4, 10],
  [0, 8],
];

function CitationMotif() {
  const [cx, cy] = NET_CENTER;
  return (
    <svg className="landing-motif" viewBox="0 0 320 260" aria-hidden="true" focusable="false">
      <g className="landing-motif-edges">
        {NET_EDGES.map(([a, b]) => {
          const from = NET_NODES[a];
          const to = NET_NODES[b];
          return from && to ? <line key={`${a}-${b}`} x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} /> : null;
        })}
        {NET_NODES.slice(0, 9).map(([x, y], index) => (
          <line key={`c-${index}`} className="landing-motif-spoke" x1={cx} y1={cy} x2={x} y2={y} />
        ))}
      </g>
      {NET_NODES.map(([x, y, r, kind, library], index) => (
        <g key={index}>
          <circle className={`landing-motif-node landing-motif-node--${kind}`} cx={x} cy={y} r={r} />
          {library && <circle className="landing-motif-mark" cx={x} cy={y} r={r * MARK_SHARE} />}
        </g>
      ))}
      <circle className="landing-motif-halo" cx={cx} cy={cy} r={20} />
      <circle className="landing-motif-ring" cx={cx} cy={cy} r={13} />
      <circle className="landing-motif-node landing-motif-node--pinned" cx={cx} cy={cy} r={9} />
    </svg>
  );
}

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
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">{t("landing.eyebrow")}</p>
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

          <div className="landing-examples">
            <span id="landing-examples-label" className="landing-examples-label">
              {t("landing.examplesLabel")}
            </span>
            <ul className="chip-row landing-examples-list" aria-labelledby="landing-examples-label">
              {EXAMPLE_QUERIES.map((example) => (
                <li key={example}>
                  <Link to={`/search?q=${encodeURIComponent(example)}`} className="chip landing-example">
                    {example}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="landing-account">
            <p className="landing-hint">{t("landing.hint")}</p>
            <div className="landing-ctas">
              <Link to="/register" className="btn btn-secondary">
                {t("auth.createAccount")}
              </Link>
              <p className="landing-signin">
                {t("landing.haveAccount")} <Link to="/login">{t("auth.signIn")}</Link>
              </p>
            </div>
          </div>
        </div>

        <div className="landing-hero-art">
          <CitationMotif />
        </div>
      </section>

      <section className="landing-section" aria-labelledby="landing-features-title">
        <SectionHeading id="landing-features-title" title={t("landing.featuresTitle")} />
        <p className="landing-section-lede">{t("landing.featuresLede")}</p>
        <ul className="landing-features">
          {FEATURES.map(({ key, icon: Icon }) => (
            <li key={key} className="landing-feature">
              <span className="landing-feature-icon" aria-hidden="true">
                <Icon size={20} strokeWidth={1.75} />
              </span>
              <h3 className="landing-feature-title">{t(`landing.features.${key}.title`)}</h3>
              <p className="landing-feature-desc">{t(`landing.features.${key}.desc`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="landing-how-title">
        <SectionHeading id="landing-how-title" title={t("landing.howTitle")} />
        <ol className="landing-steps">
          {STEPS.map((step, index) => (
            <li key={step} className="landing-step">
              <span className="landing-step-num tabular" aria-hidden="true">
                {index + 1}
              </span>
              <h3 className="landing-step-title">{t(`landing.steps.${step}.title`)}</h3>
              <p className="landing-step-desc">{t(`landing.steps.${step}.desc`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-trust" aria-labelledby="landing-trust-title">
        <h2 id="landing-trust-title" className="landing-trust-title">
          {t("landing.trustTitle")}
        </h2>
        <ul className="landing-trust-list">
          {TRUST.map(({ key, icon: Icon }) => (
            <li key={key} className="landing-trust-item">
              <Icon size={18} strokeWidth={1.75} className="landing-trust-icon" aria-hidden="true" />
              <div>
                <h3 className="landing-trust-item-title">{t(`landing.trust.${key}.title`)}</h3>
                <p className="landing-trust-item-desc">{t(`landing.trust.${key}.desc`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-cta" aria-labelledby="landing-cta-title">
        <div className="landing-cta-copy">
          <h2 id="landing-cta-title" className="landing-cta-title">
            {t("landing.ctaTitle")}
          </h2>
          <p className="landing-cta-text">{t("landing.ctaText")}</p>
        </div>
        <div className="landing-cta-actions">
          <Link to="/register" className="btn btn-primary landing-cta-btn">
            {t("auth.createAccount")}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <Link to="/search" className="btn btn-secondary landing-cta-btn">
            {t("landing.ctaSearch")}
          </Link>
        </div>
      </section>
    </div>
  );
}
