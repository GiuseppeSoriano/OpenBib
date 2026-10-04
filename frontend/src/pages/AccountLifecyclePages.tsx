import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { changeSession } from "@/lib/session";
import { useAuth } from "@/contexts/AuthContext";
import { useLegalConfig } from "@/lib/legal";
import Logo from "@/components/ui/Logo";
import "./AuthPage.css";

function hashToken() { return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""; }

interface AuthShellProps { title: string; eyebrow?: ReactNode; description?: ReactNode; children: ReactNode }

/** Full-page frame for sign-in, registration and account links: a narrow centred column on the page ground, outside the app shell. */
export function AuthShell({ title, eyebrow, description, children }: AuthShellProps) {
  const { t } = useTranslation();
  return (
    <div className="auth-page">
      <main className="auth-column">
        <Link to="/" className="auth-home" aria-label={t("shell.home")}>
          <Logo size={24} className="auth-home-logo" />
          <span className="auth-home-name">OpenBib</span>
        </Link>
        <header className="auth-header">
          {eyebrow && <p className="auth-eyebrow">{eyebrow}</p>}
          <h1 className="auth-title">{title}</h1>
          {description && <p className="auth-description">{description}</p>}
        </header>
        <div className="auth-body">{children}</div>
      </main>
    </div>
  );
}

export function CheckEmailPage() {
  const { t } = useTranslation();
  useEffect(() => { window.history.replaceState(null, "", window.location.pathname); }, []);
  return <AuthShell title={t("auth.confirmEmail")}><p className="auth-message">{t("registration.legacy")}</p><p className="auth-alt"><Link to="/register">{t("registration.restart")}</Link></p></AuthShell>;
}

export function VerifyEmailPage() { return <CheckEmailPage />; }

export function ForgotPasswordPage() {
  const { t, i18n } = useTranslation(); const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setPending(true); try { await api.post("/auth/password/forgot", { email, locale: i18n.resolvedLanguage?.startsWith("it") ? "it" : "en" }); setSent(true); } catch { setError(t("settings.actionFailed")); } finally { setPending(false); } };
  return <AuthShell title={t("auth.forgotPassword")}>{error && <div className="auth-error" role="alert">{error}</div>}{sent ? <p className="auth-message" role="status">{t("auth.checkEmailMessage")}</p> : <form className="auth-form" onSubmit={submit}><label>{t("auth.email")}<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><button className="btn btn-primary auth-submit" disabled={pending}>{t("auth.sendReset")}</button></form>}<p className="auth-alt"><Link to="/login">{t("auth.backToLogin")}</Link></p></AuthShell>;
}

export function ResetPasswordPage() {
  const { clearSession } = useAuth();
  const [token] = useState(hashToken);
  useEffect(() => { window.history.replaceState(null, "", window.location.pathname); }, []);
  const { t } = useTranslation(); const navigate = useNavigate(); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await changeSession(() => api.post("/auth/password/reset", { token, new_password: password }), clearSession); navigate("/login", { replace: true }); } catch { setError(t("auth.invalidLink")); } };
  return <AuthShell title={t("auth.resetPassword")}>{error && <div className="auth-error" role="alert">{error}</div>}<form className="auth-form" onSubmit={submit}><label>{t("auth.newPassword")}<input className="input" type="password" minLength={8} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} /></label><button className="btn btn-primary auth-submit">{t("auth.resetPassword")}</button></form></AuthShell>;
}

export function ConfirmEmailPage() {
  const { clearSession } = useAuth();
  const { t } = useTranslation(); const [message, setMessage] = useState(t("auth.pleaseWait"));
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; const token = hashToken(); window.history.replaceState(null, "", window.location.pathname); void changeSession(() => api.post("/auth/email/confirm", { token }), clearSession).then(() => setMessage(t("auth.emailChanged"))).catch(() => setMessage(t("auth.invalidLink"))); }, [t, clearSession]);
  return <AuthShell title={t("auth.confirmEmail")}><p className="auth-message" role="status">{message}</p><p className="auth-alt"><Link to="/login">{t("auth.backToLogin")}</Link></p></AuthShell>;
}

export function LegalReviewPage() {
  const { t } = useTranslation(); const [error, setError] = useState(""); const [pending, setPending] = useState(false); const { data } = useLegalConfig(); const { refreshUser, logout } = useAuth(); const navigate = useNavigate();
  if (!data) return <AuthShell title={t("auth.legalReview")}><p className="auth-message" role="status">{t("auth.pleaseWait")}</p></AuthShell>;
  const accept = async () => { setPending(true); try { await api.post("/users/me/legal-acceptance", { accept_terms: true, terms_version: data.terms_version, privacy_version: data.privacy_version }); await refreshUser(); navigate("/", { replace: true }); } catch { setError(t("settings.actionFailed")); } finally { setPending(false); } };
  return (
    <AuthShell title={t("auth.legalReview")} description={t("auth.legalChanged")}>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <p className="auth-links"><Link to="/terms">{t("auth.terms")}</Link><span aria-hidden="true">·</span><Link to="/privacy">{t("auth.privacy")}</Link></p>
      <button className="btn btn-primary auth-submit" onClick={accept} disabled={pending}>{t("auth.acceptAndContinue")}</button>
      <div className="auth-aside">
        <p className="auth-message">{t("auth.accountAccessWithoutAcceptance")}</p>
        <div className="auth-aside-actions">
          <Link className="btn btn-secondary" to="/settings">{t("settings.yourData")}</Link>
          <button className="btn btn-secondary" onClick={() => void logout().catch(() => setError(t("auth.logoutFailed")))}>{t("nav.logout")}</button>
        </div>
      </div>
    </AuthShell>
  );
}
