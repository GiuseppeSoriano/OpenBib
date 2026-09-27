import { useQuery } from "@tanstack/react-query";

/** Operator-supplied text in every shipped language (mirrors `LocalizedText` in legal.py). */
export interface LocalizedText {
  en: string;
  it: string;
}

/** Plain strings are legacy single-language values and render as written in every language. */
export type LegalText = string | LocalizedText;

export interface LegalConfig {
  schema_version: number;
  service_name: string;
  public_url: string;
  effective_date: string;
  privacy_version: string;
  terms_version: string;
  minimum_age: number;
  backups_enabled?: boolean;
  deletion_journal_enabled?: boolean | null;
  operator: { name: string; address?: string; country: LegalText; privacy_email: string; support_email: string };
  data_location: LegalText;
  third_parties: { name: string; purpose: LegalText; role: LegalText; region: LegalText; privacy_url: string; transfer_safeguard?: LegalText | null }[];
  retention: { access_logs_days: number; security_events_days: number; backups_days: number };
}

export function localize(value: LegalText | null | undefined, language: string | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return (language?.startsWith("it") ? value.it : value.en) || value.en;
}

/** Drops trailing sentence punctuation so a value can sit mid-sentence without doubling it. */
export function inlineValue(value: string): string {
  return value.replace(/[\s.;:]+$/, "");
}

async function loadLegalConfig(): Promise<LegalConfig> {
  const response = await fetch("/legal.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Legal configuration is unavailable");
  return response.json();
}

export function useLegalConfig() {
  return useQuery({ queryKey: ["legal-config"], queryFn: loadLegalConfig, staleTime: 5 * 60 * 1000 });
}
