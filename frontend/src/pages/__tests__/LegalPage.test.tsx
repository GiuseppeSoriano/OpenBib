import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LegalPage from "@/pages/LegalPage";
import type { LegalConfig } from "@/lib/legal";
import localLegal from "../../../public/legal.json";

let config: LegalConfig;
let language = "en";
vi.mock("@/lib/legal", () => ({ useLegalConfig: () => ({ data: config, isLoading: false }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: language } }) }));

beforeEach(() => { config = structuredClone(localLegal); language = "en"; });
const show = () => render(<MemoryRouter><LegalPage kind="privacy" /></MemoryRouter>);

describe.each(["en", "it"])("backup disclosure (%s)", (locale) => {
  it("does not promise backups or deletion receipts when disabled", () => {
    language = locale;
    config.backups_enabled = false;
    config.deletion_journal_enabled = false;
    config.retention.backups_days = 0;
    show();
    expect(screen.getByText(locale === "it" ? /non esegue nuovi backup/ : /does not create new backups/)).toBeInTheDocument();
    expect(screen.queryByText(locale === "it" ? /ricevuta cifrata/ : /encrypted receipt/)).not.toBeInTheDocument();
  });

  it("describes active encrypted backups and deletion receipts", () => {
    language = locale;
    config.backups_enabled = true;
    config.deletion_journal_enabled = true;
    config.retention.backups_days = 30;
    show();
    expect(screen.getByText(locale === "it" ? /esegue backup cifrati/ : /creates encrypted backups/)).toHaveTextContent("30");
    expect(screen.getByText(locale === "it" ? /ricevuta cifrata/ : /encrypted receipt/)).toBeInTheDocument();
  });

  it("keeps the journal disclosure while old snapshots expire", () => {
    language = locale;
    config.backups_enabled = false;
    config.deletion_journal_enabled = true;
    show();
    expect(screen.getByText(locale === "it" ? /non esegue nuovi backup/ : /does not create new backups/)).toBeInTheDocument();
    expect(screen.getByText(locale === "it" ? /copie precedenti/ : /previous copies/)).toBeInTheDocument();
  });
});

it("preserves the disclosure for older legal files", () => {
  delete config.backups_enabled;
  delete config.deletion_journal_enabled;
  config.retention.backups_days = 30;
  show();
  expect(screen.getByText(/creates encrypted backups/)).toHaveTextContent("30");
});

describe.each(["privacy", "terms"] as const)("optional postal address (%s)", (kind) => {
  it.each(["", "   ", undefined])("omits a missing postal address without stray commas", (address) => {
    config.operator.address = address;
    render(<MemoryRouter><LegalPage kind={kind} /></MemoryRouter>);
    const identity = screen.getByText((_, node) => node?.tagName === "P" && !!node.textContent?.startsWith(config.operator.name));
    expect(identity).toHaveTextContent(`${config.operator.name}, ${config.operator.country}.`);
    expect(identity.textContent).not.toMatch(/,\s*,/);
  });

  it("still displays a supplied postal address", () => {
    config.operator.address = "A valid postal address";
    render(<MemoryRouter><LegalPage kind={kind} /></MemoryRouter>);
    expect(screen.getByText(new RegExp(config.operator.name + ", A valid postal address"))).toBeInTheDocument();
  });
});
