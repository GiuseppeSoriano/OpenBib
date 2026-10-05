import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import api from "@/lib/api";
import Modal from "@/components/ui/Modal";
import "./CollectionSharing.css";

type ReadLink = { enabled: boolean; url: string | null };
type Member = { user_id: string; email: string; display_name: string; role: string };
export default function CollectionSharing({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const base = `/collections/${collectionId}`;
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "disable" | string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const link = useQuery({ queryKey: ["collection-read-link", collectionId], queryFn: async () => (await api.get<ReadLink>(`${base}/read-link`)).data, gcTime: 0 });
  const members = useQuery({ queryKey: ["collection-members", collectionId], queryFn: async () => (await api.get<Member[]>(`${base}/members`)).data, gcTime: 0 });
  const mutation = useMutation({
    mutationFn: async ({ action, memberId }: { action: string; memberId?: string }) => {
      if (action === "enable") await api.put(`${base}/read-link`);
      if (action === "rotate") await api.post(`${base}/read-link/rotate`);
      if (action === "disable") await api.delete(`${base}/read-link`);
      if (action === "add") await api.post(`${base}/members`, { email });
      if (action === "remove") await api.delete(`${base}/members/${memberId}`);
    },
    onMutate: () => { setError(""); setNotice(""); },
    onSuccess: async (_, { action }) => {
      setConfirm(null);
      if (action === "add") setEmail("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["collection-read-link", collectionId] }),
        client.invalidateQueries({ queryKey: ["collection-members", collectionId] }),
      ]);
      setNotice(t("sharing.saved"));
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status: number } }).response?.status;
      setError(t(status === 400 ? "sharing.accountUnavailable" : status === 429 ? "sharing.rateLimit" : "sharing.error"));
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); mutation.mutate({ action: "add" }); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.data?.url ?? ""); setNotice(t("sharing.copied")); }
    catch { setError(t("sharing.copyError")); }
  };
  return <Modal open title={t("sharing.title")} onClose={() => { if (!mutation.isPending) onClose(); }}>
    <div className="collection-sharing">
      {(error || link.isError || members.isError) && <p role="alert" className="sharing-alert">{error || t("sharing.error")}</p>}
      {notice && <p role="status" className="sharing-notice">{notice}</p>}
      {confirm ? <section>
        <h4 className="label-caps">{t("sharing.confirmTitle")}</h4>
        <p>{t(confirm === "rotate" || confirm === "disable" ? "sharing.confirmLink" : "sharing.confirmMember")}</p>
        <div className="sharing-actions">
          <button type="button" autoFocus className="btn btn-secondary" disabled={mutation.isPending} onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-danger" disabled={mutation.isPending} onClick={() => mutation.mutate(confirm === "rotate" || confirm === "disable" ? { action: confirm } : { action: "remove", memberId: confirm })}>{t("common.confirm")}</button>
        </div>
      </section> : <>
        <section>
          <div className="sharing-heading">
            <h4 className="label-caps">{t("sharing.readLink")}</h4>
            {link.data && <p className={link.data.enabled ? "sharing-status sharing-status--on" : "sharing-status"}>{t(link.data.enabled ? "sharing.enabled" : "sharing.disabled")}</p>}
          </div>
          <p className="sharing-description">{t("sharing.readDescription")}</p>
          {link.data?.enabled ? <>
            <label className="sharing-field">{t("sharing.linkLabel")}<input className="input" readOnly value={link.data.url ?? ""} onFocus={(e) => e.target.select()} /></label>
            <div className="sharing-actions">
              <button type="button" className="btn btn-primary" onClick={() => void copy()}>{t("sharing.copy")}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirm("rotate")}>{t("sharing.rotate")}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirm("disable")}>{t("sharing.disable")}</button>
            </div>
          </> : <div className="sharing-actions"><button type="button" className="btn btn-secondary" disabled={!link.data || mutation.isPending} onClick={() => mutation.mutate({ action: "enable" })}>{t("sharing.enable")}</button></div>}
        </section>
        <section>
          <h4 className="label-caps">{t("sharing.collaborators")}</h4>
          <p className="sharing-description">{t("sharing.collaboratorsDescription")}</p>
          <form onSubmit={submit} className="sharing-form">
            <label className="sharing-field">{t("sharing.email")}<input type="email" className="input" autoComplete="off" value={email} required onChange={(e) => setEmail(e.target.value)} /></label>
            <button type="submit" className="btn btn-primary" disabled={!email.trim() || mutation.isPending}>{t("sharing.add")}</button>
          </form>
          {members.data?.length === 0 && <p className="sharing-empty">{t("sharing.noCollaborators")}</p>}
          {!!members.data?.length && <ul className="sharing-members">{members.data.map((m) => <li key={m.user_id}>
            <div><strong>{m.display_name}</strong><span>{m.email}</span><small className="label-caps">{t(m.role === "editor" ? "sharing.editor" : "sharing.reader")}</small></div>
            <button type="button" className="btn-quiet btn-quiet--danger" onClick={() => setConfirm(m.user_id)}>{t("sharing.remove")}</button>
          </li>)}</ul>}
        </section>
      </>}
    </div>
  </Modal>;
}
