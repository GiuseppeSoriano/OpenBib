import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookUp, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";
import ThemeSegment from "@/components/ui/ThemeSegment";
import LanguageSegment from "@/components/ui/LanguageSegment";
import api, { zotero } from "@/lib/api";
import { changeSession } from "@/lib/session";
import SecuritySettings from "@/components/settings/SecuritySettings";
import "./SettingsPage.css";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user, clearSession, refreshUser } = useAuth();
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [reauthPassword, setReauthPassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  useEffect(() => { setDisplayName(user?.display_name ?? ""); }, [user?.display_name]);
  const onError = () => toast(t("settings.actionFailed"), "error");

  const profile = useMutation({ onError, mutationFn: () => api.patch("/users/me", { display_name: displayName }), onSuccess: async () => { await refreshUser(); toast(t("settings.saved"), "success"); } });
  const remove = useMutation({ onError, mutationFn: () => changeSession(() => api.post("/users/me/delete", { password: reauthPassword, confirmation: deleteConfirmation }), clearSession) });

  const downloadExport = async () => {
    try {
      const response = await api.post("/users/me/export", { password: reauthPassword }, { responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `openbib-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch { toast(t("settings.actionFailed"), "error"); }
  };

  return <div className="settings"><h1>{t("settings.title")}</h1>{user?.legal_acceptance_required && <div className="card settings-section"><p>{t("auth.accountAccessWithoutAcceptance")}</p><Link to="/legal-review">{t("auth.legalReview")}</Link></div>}{!user?.legal_acceptance_required && <form onSubmit={(e: FormEvent) => { e.preventDefault(); profile.mutate(); }} className="card settings-section"><h2>{t("settings.profile")}</h2><label className="settings-field">{t("settings.email")}<input className="input" value={user?.email ?? ""} disabled /></label><label className="settings-field">{t("settings.displayName")}<input className="input" minLength={1} maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label><button type="submit" className="btn btn-primary settings-self-start" disabled={profile.isPending}>{t("settings.saveChanges")}</button></form>}<SecuritySettings /><div className="card settings-section"><h2>{t("settings.appearance")}</h2><div className="settings-row"><span className="settings-label">{t("common.theme")}</span><ThemeSegment /></div><div className="settings-row"><span className="settings-label">{t("settings.language")}</span><LanguageSegment /></div></div>{!user?.legal_acceptance_required && <ZoteroSection />}<div className="card settings-section"><h2>{t("settings.yourData")}</h2><label className="settings-field">{t("settings.passwordToConfirm")}<input className="input" type="password" maxLength={128} value={reauthPassword} onChange={(e) => setReauthPassword(e.target.value)} /></label><button className="btn btn-secondary settings-self-start" disabled={!reauthPassword} onClick={() => void downloadExport()}>{t("settings.exportData")}</button></div><div className="card settings-section settings-danger"><h2>{t("settings.dangerZone")}</h2><p className="settings-hint">{t("settings.deleteAccountHelp")}</p><label className="settings-field">{t("settings.typeDelete")}<input className="input" value={deleteConfirmation} onChange={(e) => setDeleteConfirmation(e.target.value)} /></label><button className="btn btn-secondary settings-danger-btn" disabled={!reauthPassword || deleteConfirmation !== "DELETE" || remove.isPending} onClick={() => remove.mutate()}>{t("settings.deleteAccount")}</button></div></div>;
}

function ZoteroSection() {
  const { t } = useTranslation(); const { toast } = useToast(); const queryClient = useQueryClient(); const [apiKey, setApiKey] = useState("");
  const { data: status } = useQuery({ queryKey: ["zotero-status"], queryFn: () => zotero.getStatus() });
  const onError = () => toast(t("settings.actionFailed"), "error");
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["zotero-status"] });
  const connect = useMutation({ mutationFn: () => zotero.setCredentials(apiKey.trim()), onSuccess: () => { setApiKey(""); invalidate(); }, onError: () => toast(t("zotero.invalidKey"), "error") });
  const disconnect = useMutation({ onError, mutationFn: () => zotero.deleteCredentials(), onSuccess: invalidate });
  return <div className="card settings-section" data-testid="zotero-section"><h2><BookUp size={15} /> {t("zotero.title")}</h2><p className="settings-hint">{t("zotero.description")}</p>{status?.connected ? <><p className="settings-zotero-status"><CheckCircle2 size={15} />{t("zotero.connectedAs", { id: status.zotero_user_id })}<code>{status.api_key_masked}</code></p><button className="btn btn-secondary settings-self-start" onClick={() => disconnect.mutate()}>{t("zotero.disconnect")}</button></> : <form onSubmit={(e) => { e.preventDefault(); if (apiKey.trim()) connect.mutate(); }} className="settings-zotero-form"><label className="settings-field">{t("zotero.apiKeyLabel")}<input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" /></label><p className="settings-hint">{t("zotero.apiKeyHint")} <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener noreferrer">zotero.org/settings/keys</a></p><button type="submit" className="btn btn-primary settings-self-start" disabled={!apiKey.trim() || connect.isPending}>{t("zotero.connect")}</button></form>}</div>;
}
