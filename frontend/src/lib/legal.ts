import { useQuery } from "@tanstack/react-query";

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
  operator: { name: string; address?: string; country: string; privacy_email: string; support_email: string };
  data_location: string;
  third_parties: { name: string; purpose: string; role: string; region: string; privacy_url: string; transfer_safeguard?: string | null }[];
  retention: { access_logs_days: number; security_events_days: number; backups_days: number };
}

async function loadLegalConfig(): Promise<LegalConfig> {
  const response = await fetch("/legal.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Legal configuration is unavailable");
  return response.json();
}

export function useLegalConfig() {
  return useQuery({ queryKey: ["legal-config"], queryFn: loadLegalConfig, staleTime: 5 * 60 * 1000 });
}
