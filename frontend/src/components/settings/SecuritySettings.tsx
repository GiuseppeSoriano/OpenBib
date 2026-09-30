import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CheckCircle2, KeyRound, Mail, Monitor } from "lucide-react";
import type { AxiosError } from "axios";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { changeSession } from "@/lib/session";
import "./SecuritySettings.css";

type SecurityAction = "email" | "password" | "sessions";

export default function SecuritySettings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const headingId = useId();
  const [action, setAction] = useState<SecurityAction | null>(null);
  const [notice, setNotice] = useState("");
  const lastAction = useRef<SecurityAction | null>(null);
  const triggers = useRef<Partial<Record<SecurityAction, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!action && lastAction.current) triggers.current[lastAction.current]?.focus();
  }, [action]);

  function open(next: SecurityAction) {
    lastAction.current = next;
    setNotice("");
    setAction(next);
  }

  const rows = [
    { key: "email" as const, icon: Mail, title: t("settings.emailAddress"), description: user?.email ?? "", button: t("settings.editEmail") },
    { key: "password" as const, icon: KeyRound, title: t("auth.password"), description: t("settings.passwordSummary"), button: t("settings.changePassword") },
    { key: "sessions" as const, icon: Monitor, title: t("settings.sessions"), description: t("settings.sessionsSummary"), button: t("settings.logoutAll") },
  ];

  return (
    <section className="card settings-security" aria-labelledby={headingId}>
      <header className="settings-security-header">
        <h2 id={headingId}>{t("settings.security")}</h2>
        <p className="settings-hint">{t("settings.securityDescription")}</p>
      </header>
      {notice && <p className="settings-security-notice" role="status">{notice}</p>}
      {action ? (
        <SecurityEditor
          key={action}
          action={action}
          onClose={() => setAction(null)}
          onEmailSent={() => { setNotice(t("settings.emailSent")); setAction(null); }}
        />
      ) : (
        <dl className="settings-security-list">
          {rows.map(({ key, icon: Icon, title, description, button }) => (
            <div className="settings-security-row" key={key}>
              <dt><Icon size={18} aria-hidden="true" />{title}</dt>
              <dd className="settings-security-description">{description}
                {key === "email" && user?.email_verified && (
                  <span className="settings-security-verified"><CheckCircle2 size={13} aria-hidden="true" />{t("settings.emailVerified")}</span>
                )}
              </dd>
              <dd className="settings-security-action">
                <button type="button" className="btn btn-secondary" ref={element => { triggers.current[key] = element; }} onClick={() => open(key)}>{button}</button>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// Mount only the selected operation. Leaving it discards its credentials, so
// email changes and password changes never share an authentication input.
function SecurityEditor({ action, onClose, onEmailSent }: {
  action: SecurityAction;
  onClose: () => void;
  onEmailSent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { clearSession } = useAuth();
  const id = useId();
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [confirmationTouched, setConfirmationTouched] = useState(false);
  const mismatch = confirmationTouched && newPassword !== confirmation;
  const locale = i18n.resolvedLanguage?.startsWith("it") ? "it" : "en";
  const mutation = useMutation({
    mutationFn: async () => {
      if (action === "email") return api.post("/users/me/email-change", { email: newEmail, password: currentPassword, locale });
      if (action === "password") return changeSession(() => api.post("/users/me/password", { current_password: currentPassword, new_password: newPassword }), clearSession);
      return changeSession(() => api.post("/auth/logout-all"), clearSession);
    },
    onSuccess: () => { if (action === "email") onEmailSent(); },
  });
  const status = (mutation.error as AxiosError | null)?.response?.status;
  const errorKey = status === 429 ? "settings.securityRateLimited" : status === 401 && action !== "sessions" ? "settings.invalidCurrentPassword" : "settings.securityFailed";
  const title = action === "email" ? "settings.editEmail" : action === "password" ? "settings.changePassword" : "settings.confirmLogoutAll";
  const description = action === "email" ? "settings.emailChangeHelp" : action === "password" ? "settings.passwordChangeHelp" : "settings.logoutAllHelp";
  const disabled = mutation.isPending || (action === "email" && (!newEmail || !currentPassword)) || (action === "password" && (!currentPassword || newPassword.length < 8 || !confirmation || newPassword !== confirmation));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action === "password") setConfirmationTouched(true);
    if (!disabled) mutation.mutate();
  }

  return (
    <div className="settings-security-editor">
      <button type="button" className="btn-ghost settings-security-back" onClick={onClose} disabled={mutation.isPending}><ArrowLeft size={15} aria-hidden="true" />{t("settings.security")}</button>
      <h3 id={`${id}-title`}>{t(title)}</h3>
      <p className="settings-hint" id={`${id}-help`}>{t(description)}</p>
      <form className="settings-security-form" onSubmit={submit} aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} aria-busy={mutation.isPending}>
        {action === "email" && (
          <label className="settings-field">{t("settings.newEmail")}
            <input className="input" type="email" autoComplete="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required autoFocus disabled={mutation.isPending} />
          </label>
        )}
        {action !== "sessions" && (
          <label className="settings-field">{t("settings.currentPassword")}
            <input className="input" type="password" autoComplete="current-password" maxLength={128} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required autoFocus={action === "password"} disabled={mutation.isPending} />
          </label>
        )}
        {action === "password" && <>
          <div className="settings-field">
            <label className="settings-field">{t("settings.newPassword")}
              <input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onChange={e => setNewPassword(e.target.value)} required aria-describedby={`${id}-password-help`} disabled={mutation.isPending} />
            </label>
            <span className="settings-hint" id={`${id}-password-help`}>{t("auth.passwordHelp")}</span>
          </div>
          <label className="settings-field">{t("settings.confirmNewPassword")}
            <input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} onBlur={() => setConfirmationTouched(true)} required aria-invalid={mismatch} aria-describedby={mismatch ? `${id}-mismatch` : undefined} disabled={mutation.isPending} />
          </label>
          {mismatch && <p className="settings-security-error" id={`${id}-mismatch`} role="alert">{t("auth.passwordMismatch")}</p>}
        </>}
        {mutation.isError && <p className="settings-security-error" role="alert">{t(errorKey)}</p>}
        <div className="settings-security-actions">
          <button type="submit" className="btn btn-primary" disabled={disabled}>{t(mutation.isPending ? "auth.pleaseWait" : action === "email" ? "settings.changeEmail" : action === "password" ? "settings.updatePassword" : "settings.logoutAll")}</button>
          <button type="button" className="btn btn-secondary" disabled={mutation.isPending} autoFocus={action === "sessions"} onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </form>
    </div>
  );
}
