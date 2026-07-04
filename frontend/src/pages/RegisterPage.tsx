import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/ui/Logo";
import "./AuthPage.css";

export default function RegisterPage() {
  const { t } = useTranslation();
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await register(email, password, displayName || undefined);
      navigate("/");
    } catch {
      setError(t("auth.registerError"));
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-header">
          <Logo size={44} className="auth-logo" />
          <h1>{t("auth.createAccount")}</h1>
          <p>{t("auth.getStarted")}</p>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            {t("auth.email")}
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            {t("auth.displayName")}
            <input
              className="input"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("auth.optional")}
            />
          </label>
          <label>
            {t("auth.password")}
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </label>
          <button type="submit" className="btn btn-primary auth-submit">
            {t("auth.createAccount")}
          </button>
        </form>

        <p className="auth-alt">
          {t("auth.haveAccount")} <Link to="/login">{t("auth.signIn")}</Link>
        </p>
      </div>
    </div>
  );
}
