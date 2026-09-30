import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import LegalPage from "@/pages/LegalPage";
import type { LegalConfig } from "@/lib/legal";
import localLegal from "../../../public/legal.json";

let config: LegalConfig | undefined;
let loading = false;
vi.mock("@/lib/legal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/legal")>()),
  useLegalConfig: () => ({ data: config, isLoading: loading, error: null }),
}));

const legal = () => config as LegalConfig;

beforeEach(() => {
  config = structuredClone(localLegal) as LegalConfig;
  loading = false;
});

async function show(kind: "privacy" | "terms" = "privacy", language = "en") {
  await i18n.changeLanguage(language);
  return render(
    <MemoryRouter>
      <LegalPage kind={kind} />
    </MemoryRouter>,
  );
}

const ENGLISH = ["Application and database hosting", "European Union", "Standard contractual clauses", "Italy"];
const ITALIAN = ["Hosting dell’applicazione e del database", "Unione europea", "Clausole contrattuali standard", "Italia"];

function localize() {
  const c = legal();
  c.data_location = { en: "European Union.", it: "Unione europea." };
  c.operator.country = { en: "Italy.", it: "Italia." };
  c.third_parties = [
    {
      name: "Hosting provider with an exceptionally long legal entity name GmbH & Co. KG",
      purpose: { en: "Application and database hosting.", it: "Hosting dell’applicazione e del database." },
      role: "processor",
      region: { en: "European Union.", it: "Unione europea." },
      privacy_url: "https://host.test/privacy",
      transfer_safeguard: { en: "Standard contractual clauses.", it: "Clausole contrattuali standard." },
    },
  ];
}

describe.each(["en", "it"])("backup disclosure (%s)", (locale) => {
  it("does not promise backups or deletion receipts when disabled", async () => {
    legal().backups_enabled = false;
    legal().deletion_journal_enabled = false;
    legal().retention.backups_days = 0;
    await show("privacy", locale);
    expect(screen.getByText(locale === "it" ? /non esegue nuovi backup/ : /does not create new backups/)).toBeInTheDocument();
    expect(screen.queryByText(locale === "it" ? /ricevuta cifrata/ : /encrypted receipt/)).not.toBeInTheDocument();
  });

  it("describes active encrypted backups and deletion receipts", async () => {
    legal().backups_enabled = true;
    legal().deletion_journal_enabled = true;
    legal().retention.backups_days = 30;
    await show("privacy", locale);
    expect(screen.getByText(locale === "it" ? /esegue backup cifrati/ : /creates encrypted backups/)).toHaveTextContent("30");
    expect(screen.getByText(locale === "it" ? /ricevuta cifrata/ : /encrypted receipt/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: locale === "it" ? /scaricare una copia/ : /download a copy/ })).not.toBeInTheDocument();
  });

  it("keeps the journal disclosure while old snapshots expire", async () => {
    legal().backups_enabled = false;
    legal().deletion_journal_enabled = true;
    await show("privacy", locale);
    expect(screen.getByText(locale === "it" ? /non esegue nuovi backup/ : /does not create new backups/)).toBeInTheDocument();
    expect(screen.getByText(locale === "it" ? /copie precedenti/ : /previous copies/)).toBeInTheDocument();
  });

  it("links the export sentences to the data export in Settings", async () => {
    legal().backups_enabled = false;
    const { unmount } = await show("privacy", locale);
    const privacyLink = screen.getByRole("link", {
      name: locale === "it" ? "scaricare una copia dei tuoi dati dalle impostazioni" : "download a copy of your data in Settings",
    });
    expect(privacyLink).toHaveAttribute("href", "/settings#your-data");
    unmount();
    await show("terms", locale);
    const termsLink = screen.getByRole("link", { name: locale === "it" ? "esportare i dati" : "export data" });
    expect(termsLink).toHaveAttribute("href", "/settings#your-data");
  });
});

it("preserves the disclosure for older legal files", async () => {
  delete legal().backups_enabled;
  delete legal().deletion_journal_enabled;
  legal().retention.backups_days = 30;
  await show();
  expect(screen.getByText(/creates encrypted backups/)).toHaveTextContent("30");
});

describe("localized operator data", () => {
  it("shows only English values on the English page", async () => {
    localize();
    const { container } = await show("privacy", "en");
    for (const value of ENGLISH) expect(container.textContent).toContain(value);
    for (const value of ITALIAN) expect(container.textContent).not.toContain(value);
    expect(screen.getByText(/Data is hosted in: European Union\. Deleting/)).toBeInTheDocument();
  });

  it("shows only Italian values on the Italian page", async () => {
    localize();
    const { container } = await show("privacy", "it");
    expect(screen.getByRole("heading", { level: 1, name: "Informativa privacy" })).toBeInTheDocument();
    for (const value of ITALIAN) expect(container.textContent).toContain(value);
    for (const value of ENGLISH) expect(container.textContent).not.toContain(value);
    expect(screen.getByText(/I dati sono ospitati in: Unione europea\. La cancellazione/)).toBeInTheDocument();
  });

  it("renders legacy single-language values in every language", async () => {
    legal().data_location = "Unione europea";
    legal().third_parties = [
      {
        name: "Host",
        purpose: "Hosting dell’applicazione",
        role: "responsabile esterno",
        region: "Unione europea",
        privacy_url: "https://host.test/privacy",
      },
    ];
    await show("privacy", "en");
    expect(screen.getByRole("listitem")).toHaveTextContent("Host (opens in a new tab): Hosting dell’applicazione (responsabile esterno, Unione europea)");
    expect(screen.getByText(/Data is hosted in: Unione europea\./)).toBeInTheDocument();
  });

  it.each([
    ["privacy", "en", "plain"],
    ["privacy", "it", "plain"],
    ["privacy", "en", "localized"],
    ["privacy", "it", "localized"],
    ["terms", "en", "plain"],
    ["terms", "it", "localized"],
  ] as const)("never doubles the final period (%s, %s, %s values)", async (kind, language, form) => {
    if (form === "localized") {
      localize();
    } else {
      legal().data_location = "European Union.";
      legal().operator.country = "Italy.";
      legal().third_parties = [
        {
          name: "Host",
          purpose: "Hosting;",
          role: "processor",
          region: "Italy.",
          privacy_url: "https://host.test/privacy",
          transfer_safeguard: "Adequacy decision. ",
        },
      ];
    }
    const { container } = await show(kind, language);
    expect(container.textContent).not.toMatch(/\.\s*\./);
    expect(container.textContent).not.toMatch(/[;:]\s*\)/);
  });

  it.each([
    ["en", "processor", "processor"],
    ["it", "processor", "responsabile del trattamento"],
    ["it", "Sub-Processor", "sub-responsabile del trattamento"],
    ["it", "Independent controller", "titolare autonomo del trattamento"],
  ])("translates the known role %s → %s", async (language, value, expected) => {
    legal().third_parties = [
      { name: "Host", purpose: "Hosting", role: value, region: "EU", privacy_url: "https://host.test/privacy" },
    ];
    await show("privacy", language);
    expect(screen.getByRole("listitem")).toHaveTextContent(`(${expected}, EU)`);
  });

  it("marks provider links as external", async () => {
    localize();
    await show("privacy", "en");
    const link = screen.getByRole("link", { name: /exceptionally long legal entity name/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(/ \(opens in a new tab\)$/);
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe.each(["privacy", "terms"] as const)("optional postal address (%s)", (kind) => {
  it.each(["", "   ", undefined])("omits a missing postal address without stray commas", async (address) => {
    legal().operator.address = address;
    await show(kind);
    const identity = screen.getByText((_, node) => node?.tagName === "P" && !!node.textContent?.startsWith(legal().operator.name));
    expect(identity).toHaveTextContent(`${legal().operator.name}, ${legal().operator.country}.`);
    expect(identity.textContent).not.toMatch(/,\s*,/);
  });

  it("still displays a supplied postal address", async () => {
    legal().operator.address = "A valid postal address";
    await show(kind);
    expect(screen.getByText(new RegExp(legal().operator.name + ", A valid postal address"))).toBeInTheDocument();
  });
});

describe("page states", () => {
  it("localizes the loading and unavailable messages", async () => {
    loading = true;
    config = undefined;
    const { unmount } = await show("privacy", "it");
    expect(screen.getByText("Caricamento…")).toBeInTheDocument();
    unmount();
    loading = false;
    await show("terms", "it");
    expect(screen.getByText("Le informazioni legali non sono disponibili.")).toBeInTheDocument();
  });
});

describe.each(["en", "it"])("sharing and registration disclosures (%s)", (locale) => {
  it("names Semantic Scholar, the DOI check and temporary registration", async () => {
    await show("privacy", locale);
    expect(screen.getByText(/Semantic Scholar/)).toHaveTextContent("doi.org");
    expect(screen.getByText(locale === "it" ? /La registrazione temporanea/ : /Temporary registration stores/)).toBeInTheDocument();
    expect(screen.getByText(locale === "it" ? /registrazione temporanea usano cookie/ : /temporary registration use technical/)).toBeInTheDocument();
  });

  it("describes read-only links and collaborators in the terms", async () => {
    await show("terms", locale);
    expect(screen.getByText(locale === "it" ? /link di sola lettura e collaboratori autorizzati/ : /read-only links and authorized collaborators/)).toBeInTheDocument();
  });
});
