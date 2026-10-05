import { safeReturnTo } from "@/lib/collection-access";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { AuthShell } from "@/pages/AccountLifecyclePages";

export default function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
      navigate(safeReturnTo(location.state?.returnTo), { replace: true });
    } catch {
      setError(t("auth.loginError"));
    }
  };

  return (
    <AuthShell title={t("auth.welcomeBack")} description={t("auth.signInSubtitle")}>
      {error && <div className="auth-error" role="alert">{error}</div>}

      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          {t("auth.email")}
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          {t("auth.password")}
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            maxLength={128}
          />
        </label>
        <button type="submit" className="btn btn-primary auth-submit">
          {t("auth.signIn")}
        </button>
        <Link className="auth-forgot" to="/forgot-password">{t("auth.forgotPassword")}</Link>
      </form>

      <p className="auth-alt">
        {t("auth.noAccount")} <Link to="/register">{t("auth.signUp")}</Link>
      </p>
    </AuthShell>
  );
}
