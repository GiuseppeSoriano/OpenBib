import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AxiosError } from "axios";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { AuthShell } from "@/pages/AccountLifecyclePages";
import { useLegalConfig } from "@/lib/legal";
import type { RegistrationStatus } from "@/types";

export default function RegisterPage() {
  const { t, i18n } = useTranslation();
  const { completeRegistration } = useAuth();
  const legal = useLegalConfig();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<RegistrationStatus>({ stage: "email" });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const passwordMismatch = passwordConfirmation.length > 0 && password !== passwordConfirmation;
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());

  const updateFlow = (data: RegistrationStatus) => {
    setFlow(data);
    setResendAt(Date.now() + (data.resend_after ?? 0) * 1000);
  };
  useEffect(() => {
    let active = true;
    api.get<RegistrationStatus>("/auth/registration/status")
      .then(({ data }) => { if (active) updateFlow(data); })
      .catch(() => { if (active) setError(t("registration.failed")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [t]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshStatus = async () => {
    try { updateFlow((await api.get<RegistrationStatus>("/auth/registration/status")).data); }
    catch { /* Keep the current form and its error; the user can retry. */ }
  };
  const showError = async (reason: unknown) => {
    const e = reason as AxiosError<{ detail?: unknown }>;
    const detail = e.response?.data?.detail;
    const keys: Record<string, string> = {
      registration_expired: "expired", registration_locked: "locked",
      registration_code_expired: "codeExpired", registration_code_invalid: "invalidCode",
      registration_resend_wait: "wait", registration_legal_changed: "legalChanged",
      registration_unavailable: "unavailable",
    };
    const key = typeof detail === "string" ? keys[detail] : undefined;
    setError(t(`registration.${key ?? (e.response?.status === 429 ? "rateLimited" : "failed")}`));
    if (detail === "registration_legal_changed") {
      setAccepted(false);
      await legal.refetch();
    }
    await refreshStatus();
    // A shared IP/email rate limit can exceed the per-challenge cooldown.
    const retry = Number(e.response?.headers?.["retry-after"]);
    if (retry > 0) setResendAt(Date.now() + retry * 1000);
  };
  const run = async (action: () => Promise<void>) => {
    setPending(true); setError(""); setNotice("");
    try { await action(); } catch (e) { await showError(e); } finally { setPending(false); }
  };
  const start = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { data } = await api.post<RegistrationStatus>("/auth/registration/start", {
        email, locale: i18n.resolvedLanguage?.startsWith("it") ? "it" : "en",
      });
      updateFlow(data); setCode(""); setPassword(""); setPasswordConfirmation(""); setAccepted(false);
      setNotice(t("registration.sent"));
    });
  };
  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      updateFlow((await api.post<RegistrationStatus>("/auth/registration/verify", { code })).data);
      setCode("");
    });
  };
  const complete = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!legal.data || !accepted || password !== passwordConfirmation) return;
      await completeRegistration({ password, displayName, termsVersion: legal.data.terms_version, privacyVersion: legal.data.privacy_version });
      setPassword(""); setPasswordConfirmation(""); navigate("/", { replace: true });
    });
  };
  const restart = () => { setFlow({ stage: "email" }); setError(""); setNotice(""); setCode(""); setPassword(""); setPasswordConfirmation(""); setAccepted(false); };
  const expired = !!flow.expires_at && Date.parse(flow.expires_at) <= now;
  const stage = expired ? "expired" : flow.stage;
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const codeExpired = !!flow.otp_expires_at && Date.parse(flow.otp_expires_at) <= now;
  const step = stage === "profile" ? 3 : stage === "otp" ? 2 : 1;

  return <AuthShell
    eyebrow={t("registration.step", { step })}
    title={t(`registration.${stage === "profile" ? "profileTitle" : stage === "otp" ? "otpTitle" : "emailTitle"}`)}
    description={t(`registration.${stage === "profile" ? "profileHelp" : stage === "otp" ? "otpHelp" : "emailHelp"}`, { email: flow.email_masked })}
  >
    {error && <div className="auth-error" role="alert">{error}</div>}
    {notice && <p className="auth-message" role="status">{notice}</p>}
    {loading ? <p className="auth-message" role="status">{t("auth.pleaseWait")}</p> : <>
      {stage === "email" && <form className="auth-form" onSubmit={start}>
        <label>{t("auth.email")}<input className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></label>
        <p className="auth-help"><Link to="/privacy">{t("auth.privacy")}</Link></p>
        <button className="btn btn-primary auth-submit" disabled={pending}>{t("registration.send")}</button>
      </form>}
      {stage === "otp" && <form className="auth-form" onSubmit={verify}>
        <label>{t("registration.code")}<input className="input registration-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} minLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\s/g, ""))} required autoFocus aria-describedby="otp-help" /></label>
        <p id="otp-help" className="auth-help">{t(codeExpired ? "registration.codeExpired" : "registration.codeHelp")}</p>
        <button className="btn btn-primary" disabled={pending || code.length !== 6 || codeExpired}>{t("registration.verify")}</button>
        <button type="button" className="btn btn-secondary" disabled={pending || wait > 0} onClick={() => void run(async () => {
          updateFlow((await api.post<RegistrationStatus>("/auth/registration/resend")).data);
          setCode(""); setNotice(t("registration.sent"));
        })}>{wait > 0 ? t("registration.resendWait", { seconds: wait }) : t("registration.resend")}</button>
      </form>}
      {stage === "profile" && <form className="auth-form" onSubmit={complete}>
        <label>{t("auth.displayName")}<input className="input" type="text" autoComplete="name" minLength={1} maxLength={100} value={displayName} onChange={e => setDisplayName(e.target.value)} required autoFocus /></label>
        <label>{t("auth.password")}<input className="input" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} maxLength={128} /><span className="auth-help">{t("auth.passwordHelp")}</span></label>
        <label>{t("auth.confirmPassword")}<input className="input" type="password" autoComplete="new-password" value={passwordConfirmation} onChange={e => setPasswordConfirmation(e.target.value)} required minLength={8} maxLength={128} aria-invalid={passwordMismatch} aria-describedby={passwordMismatch ? "password-mismatch" : undefined} /></label>
        {passwordMismatch && <p id="password-mismatch" className="auth-error" role="alert">{t("auth.passwordMismatch")}</p>}
        <label className="auth-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} required /><span>{t("auth.acceptLegal")} <Link to="/terms">{t("auth.terms")}</Link> {t("auth.acknowledgePrivacy")} <Link to="/privacy">{t("auth.privacy")}</Link></span></label>
        {legal.isError && <p role="alert" className="auth-error">{t("registration.failed")} <button type="button" className="btn btn-secondary" onClick={() => void legal.refetch()}>{t("common.retry")}</button></p>}
        <button className="btn btn-primary auth-submit" disabled={pending || !accepted || !legal.data || password !== passwordConfirmation}>{t("auth.createAccount")}</button>
      </form>}
      {(stage === "expired" || stage === "locked") && <p role="alert" className="auth-error">{t(`registration.${stage}`)}</p>}
      {stage !== "email" && <button type="button" className="btn-ghost registration-restart" disabled={pending} onClick={restart}>{t(stage === "otp" || stage === "profile" ? "registration.changeEmail" : "registration.restart")}</button>}
    </>}
    <p className="auth-alt">{t("auth.haveAccount")} <Link to="/login">{t("auth.signIn")}</Link></p>
  </AuthShell>;
}
