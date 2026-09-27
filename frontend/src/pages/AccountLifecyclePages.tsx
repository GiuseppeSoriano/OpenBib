import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import { changeSession } from "@/lib/session";
import { useAuth } from "@/contexts/AuthContext";
import { useLegalConfig } from "@/lib/legal";
import "./AuthPage.css";

function hashToken() { return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""; }
function Shell({ title, children }: { title: string; children: ReactNode }) { return <div className="auth-page"><div className="auth-card card"><div className="auth-header"><h1>{title}</h1></div>{children}</div></div>; }

export function CheckEmailPage() {
  const { t } = useTranslation();
  useEffect(() => { window.history.replaceState(null, "", window.location.pathname); }, []);
  return <Shell title={t("auth.confirmEmail")}><p className="auth-message">{t("registration.legacy")}</p><p className="auth-alt"><Link to="/register">{t("registration.restart")}</Link></p></Shell>;
}

export function VerifyEmailPage() { return <CheckEmailPage />; }

export function ForgotPasswordPage() {
  const { t, i18n } = useTranslation(); const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setPending(true); try { await api.post("/auth/password/forgot", { email, locale: i18n.resolvedLanguage?.startsWith("it") ? "it" : "en" }); setSent(true); } catch { setError(t("settings.actionFailed")); } finally { setPending(false); } };
  return <Shell title={t("auth.forgotPassword")}>{error && <div className="auth-error">{error}</div>}{sent ? <p className="auth-message">{t("auth.checkEmailMessage")}</p> : <form className="auth-form" onSubmit={submit}><label>{t("auth.email")}<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><button className="btn btn-primary auth-submit" disabled={pending}>{t("auth.sendReset")}</button></form>}<p className="auth-alt"><Link to="/login">{t("auth.backToLogin")}</Link></p></Shell>;
}

export function ResetPasswordPage() {
  const { clearSession } = useAuth();
  const [token] = useState(hashToken);
  useEffect(() => { window.history.replaceState(null, "", window.location.pathname); }, []);
  const { t } = useTranslation(); const navigate = useNavigate(); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await changeSession(() => api.post("/auth/password/reset", { token, new_password: password }), clearSession); navigate("/login", { replace: true }); } catch { setError(t("auth.invalidLink")); } };
  return <Shell title={t("auth.resetPassword")}>{error && <div className="auth-error">{error}</div>}<form className="auth-form" onSubmit={submit}><label>{t("auth.newPassword")}<input className="input" type="password" minLength={8} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} /></label><button className="btn btn-primary auth-submit">{t("auth.resetPassword")}</button></form></Shell>;
}

export function ConfirmEmailPage() {
  const { clearSession } = useAuth();
  const { t } = useTranslation(); const [message, setMessage] = useState(t("auth.pleaseWait"));
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; const token = hashToken(); window.history.replaceState(null, "", window.location.pathname); void changeSession(() => api.post("/auth/email/confirm", { token }), clearSession).then(() => setMessage(t("auth.emailChanged"))).catch(() => setMessage(t("auth.invalidLink"))); }, [t, clearSession]);
  return <Shell title={t("auth.confirmEmail")}><p className="auth-message">{message}</p><p className="auth-alt"><Link to="/login">{t("auth.backToLogin")}</Link></p></Shell>;
}

export function LegalReviewPage() {
  const { t } = useTranslation(); const [error, setError] = useState(""); const [pending, setPending] = useState(false); const { data } = useLegalConfig(); const { refreshUser, logout } = useAuth(); const navigate = useNavigate();
  if (!data) return <Shell title={t("auth.legalReview")}><p>{t("auth.pleaseWait")}</p></Shell>;
  const accept = async () => { setPending(true); try { await api.post("/users/me/legal-acceptance", { accept_terms: true, terms_version: data.terms_version, privacy_version: data.privacy_version }); await refreshUser(); navigate("/", { replace: true }); } catch { setError(t("settings.actionFailed")); } finally { setPending(false); } };
  return <Shell title={t("auth.legalReview")}>{error && <div className="auth-error">{error}</div>}<p className="auth-message">{t("auth.legalChanged")}</p><p className="auth-message"><Link to="/terms">{t("auth.terms")}</Link> · <Link to="/privacy">{t("auth.privacy")}</Link></p><button className="btn btn-primary auth-submit" onClick={accept} disabled={pending}>{t("auth.acceptAndContinue")}</button><p className="auth-message">{t("auth.accountAccessWithoutAcceptance")}</p><p className="auth-alt"><Link to="/settings">{t("settings.yourData")}</Link></p><button className="btn btn-secondary" onClick={() => void logout().catch(() => setError(t("settings.logoutFailed")))}>{t("nav.logout")}</button></Shell>;
}
