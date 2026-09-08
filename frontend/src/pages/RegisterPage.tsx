import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/ui/Logo";
import { useLegalConfig } from "@/lib/legal";
import "./AuthPage.css";

export default function RegisterPage() {
  const { t, i18n } = useTranslation();
  const { register } = useAuth();
  const { data: legal } = useLegalConfig();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (!legal) throw new Error("Legal configuration unavailable");
      await register({ email, password, displayName, locale: i18n.resolvedLanguage?.startsWith("it") ? "it" : "en", termsVersion: legal.terms_version, privacyVersion: legal.privacy_version });
      navigate("/check-email");
    } catch {
      setError(t("auth.registerError"));
    }
  };

  return <div className="auth-page"><div className="auth-card card"><div className="auth-header"><Logo size={44} className="auth-logo" /><h1>{t("auth.createAccount")}</h1><p>{t("auth.getStarted")}</p></div>{error && <div className="auth-error">{error}</div>}<form onSubmit={handleSubmit} className="auth-form"><label>{t("auth.email")}<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label><label>{t("auth.displayName")}<input className="input" type="text" minLength={1} maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></label><label>{t("auth.password")}<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={15} maxLength={128} /><span className="auth-help">{t("auth.passwordHelp")}</span></label><label className="auth-check"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required /><span>{t("auth.acceptLegal")} <Link to="/terms">{t("auth.terms")}</Link> {t("auth.acknowledgePrivacy")} <Link to="/privacy">{t("auth.privacy")}</Link></span></label><button type="submit" className="btn btn-primary auth-submit" disabled={!accepted || !legal}>{t("auth.createAccount")}</button></form><p className="auth-alt">{t("auth.haveAccount")} <Link to="/login">{t("auth.signIn")}</Link></p></div></div>;
}
