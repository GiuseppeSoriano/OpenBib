import { testAuth, mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "@/pages/SettingsPage";
import api from "@/lib/api";
import { mockMatchMedia, renderWithProviders, restoreMatchMedia } from "@/test/utils";
import { PHONE_QUERY } from "@/lib/breakpoints";
import type { ZoteroStatus } from "@/types";

const zoteroState: { status: ZoteroStatus } = {
  status: { connected: false, zotero_user_id: null, api_key_masked: null },
};

const legalState: { backups_enabled?: boolean } = {};

vi.mock("@/lib/legal", () => ({
  useLegalConfig: () => ({ data: { ...legalState }, isLoading: false }),
}));

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn((url: string) => {
      if (url === "/users/me")
        return Promise.resolve({
          data: { id: "u1", email: "me@example.com", display_name: "Me", created_at: "2026-01-01" },
        });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  zotero: {
    getStatus: vi.fn(() => Promise.resolve(zoteroState.status)),
    setCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
  },
  papers: {},
  library: {},
  notes: {},
  graph: {},
}));

beforeEach(() => {
  zoteroState.status = { connected: false, zotero_user_id: null, api_key_masked: null };
  delete legalState.backups_enabled;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("SettingsPage — appearance", () => {
  it("theme preview cards are a radio group that sets and persists the preference", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    const group = await screen.findByRole("radiogroup", { name: "Theme" });
    expect(group).toHaveAttribute("data-testid", "theme-segment");
    const dark = within(group).getByRole("radio", { name: "Dark" });
    fireEvent.click(dark);

    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(dark).toHaveAttribute("tabindex", "0");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("openbib.theme")).toBe("dark");

    // One tab stop; the arrow keys move and select, wrapping at the ends.
    fireEvent.keyDown(dark, { key: "ArrowRight" });
    const system = within(group).getByRole("radio", { name: "System" });
    expect(system).toHaveAttribute("aria-checked", "true");
    expect(system).toHaveFocus();
    fireEvent.keyDown(system, { key: "ArrowRight" });
    expect(within(group).getByRole("radio", { name: "Light" })).toHaveFocus();
    expect(localStorage.getItem("openbib.theme")).toBe("light");
  });

  it("language segmented control switches and persists the language", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    const group = await screen.findByRole("radiogroup", { name: "Language" });
    expect(group).toHaveAttribute("data-testid", "language-segment");
    expect(within(group).getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(group).getByRole("radio", { name: "Italiano" }));

    await waitFor(() => expect(localStorage.getItem("openbib.lang")).toBe("it"));
    expect(document.documentElement.lang).toBe("it");
  });
});

describe("SettingsPage — Zotero", () => {
  it("shows the connect form when Zotero is not configured", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    const section = await screen.findByTestId("zotero-section");
    expect(section).toBeInTheDocument();
    expect(screen.getByText("Zotero API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    const keys = screen.getByRole("link", { name: /^zotero\.org\/settings\/keys/ });
    expect(keys).toHaveAttribute("href", "https://www.zotero.org/settings/keys");
    expect(keys).toHaveAccessibleName("zotero.org/settings/keys (opens in a new tab)");
  });

  it("focuses the API key input when opened at #zotero", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings#zotero" });

    const input = await screen.findByLabelText("Zotero API key");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("focuses the section at #zotero once Zotero is connected", async () => {
    zoteroState.status = { connected: true, zotero_user_id: "777", api_key_masked: "****efgh" };
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings#zotero" });

    await screen.findByText("Connected to Zotero user 777");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("zotero-section")));
  });

  it("shows the connected state with a masked key and disconnect action", async () => {
    zoteroState.status = {
      connected: true,
      zotero_user_id: "777",
      api_key_masked: "********efgh",
    };
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Connected to Zotero user 777")).toBeInTheDocument();
    expect(screen.getByText("********efgh")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByText("Zotero API key")).toBeNull();
  });
});

describe("SettingsPage — your data", () => {
  it("focuses the export section at #your-data and explains the export", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings#your-data" });

    const section = await screen.findByRole("region", { name: "Your data" });
    expect(section).toHaveAttribute("id", "your-data");
    expect(within(section).getByText(/Download a JSON copy of your profile/)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(section));
  });

  it("warns that there are no backups only when the instance keeps none", async () => {
    testAuth.authenticated = true;
    const { unmount } = renderWithProviders(<SettingsPage />);
    await screen.findByRole("region", { name: "Your data" });
    expect(screen.queryByText(/does not keep backups/)).toBeNull();
    unmount();

    legalState.backups_enabled = false;
    renderWithProviders(<SettingsPage />);
    const notice = await screen.findByText(/This OpenBib instance does not keep backups/);
    expect(within(notice).getByRole("link", { name: "Read the privacy notice" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("gives account deletion its own password", async () => {
    testAuth.authenticated = true;
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    renderWithProviders(<SettingsPage />);

    fireEvent.change(await screen.findByLabelText("Password to confirm"), { target: { value: "export-secret" } });
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    const deleteButton = screen.getByRole("button", { name: "Delete account" });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Password to delete your account"), { target: { value: "delete-secret" } });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/users/me/delete", { password: "delete-secret", confirmation: "DELETE" }),
    );
  });
});

describe("SettingsPage — section index", () => {
  it("links every section by anchor and marks the deep-linked one", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings#your-data" });

    const index = await screen.findByRole("navigation", { name: "Settings sections" });
    const links = within(index).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Profile",
      "Sign-in and security",
      "Appearance",
      "Integrations",
      "Your data",
      "Delete account",
    ]);
    expect(within(index).getByRole("link", { name: "Integrations" })).toHaveAttribute("href", "/settings#zotero");
    const current = within(index).getByRole("link", { name: "Your data" });
    expect(current).toHaveAttribute("href", "/settings#your-data");
    expect(current).toHaveAttribute("aria-current", "true");
    expect(index.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    for (const id of ["profile", "security", "appearance", "zotero", "your-data", "delete-account"]) {
      expect(document.getElementById(id)).toHaveAttribute("tabindex", "-1");
    }
  });

  it("marks Appearance for #language and focuses the language row", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings#language" });

    const index = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(index).getByRole("link", { name: "Appearance" })).toHaveAttribute("aria-current", "true");
    const row = document.getElementById("language")!;
    expect(within(row).getByRole("radiogroup", { name: "Language" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("moves focus to a section chosen in the index", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    const index = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(index).getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(index).getByRole("link", { name: "Sign-in and security" }));
    const section = screen.getByRole("region", { name: "Sign-in and security" });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(within(index).getByRole("link", { name: "Sign-in and security" })).toHaveAttribute("aria-current", "true");
  });
});

describe("SettingsPage — profile", () => {
  it("saves the display name and resets an unsaved edit on cancel", async () => {
    testAuth.authenticated = true;
    vi.mocked(api.patch).mockResolvedValue({ data: {} });
    renderWithProviders(<SettingsPage />);

    const name = await screen.findByLabelText("Display name");
    await waitFor(() => expect(name).toHaveValue("Me"));
    expect(name).toHaveAccessibleDescription("Shown to collaborators on shared collections.");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    fireEvent.change(name, { target: { value: "Someone" } });
    fireEvent.click(cancel);
    expect(name).toHaveValue("Me");

    fireEvent.change(name, { target: { value: "Reader" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/users/me", { display_name: "Reader" }));
    expect(within(screen.getByRole("region", { name: "Profile" })).getByText("me@example.com")).toBeInTheDocument();
  });
});

describe("SettingsPage — phones", () => {
  beforeEach(() => {
    mockMatchMedia((query) => query === PHONE_QUERY);
  });
  afterEach(() => {
    restoreMatchMedia();
  });

  it("lists the sections with their state and drills into one with a back link", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings" });

    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const list = screen.getByRole("navigation", { name: "Settings sections" });
    const integrations = await within(list).findByRole("link", { name: /^Integrations/ });
    expect(integrations).toHaveAccessibleName("Integrations Zotero off");
    expect(within(list).getByRole("link", { name: "Appearance System" })).toHaveAttribute("href", "/settings#appearance");
    expect(within(list).getByRole("link", { name: "Language English" })).toHaveAttribute("href", "/settings#language");
    expect(within(list).getByRole("link", { name: "Your data Export" })).toHaveAttribute("href", "/settings#your-data");
    expect(within(list).getByRole("link", { name: "Delete account" })).toBeInTheDocument();
    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();

    fireEvent.click(integrations);
    expect(await screen.findByRole("heading", { level: 1, name: "Integrations" })).toBeInTheDocument();
    const section = screen.getByTestId("zotero-section");
    expect(section).toHaveAccessibleName("Integrations");
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Your data" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Zotero API key")));

    fireEvent.click(screen.getByRole("link", { name: "Back to Settings" }));
    const again = await screen.findByRole("link", { name: "Integrations Zotero off" });
    await waitFor(() => expect(again).toHaveFocus());
  });

  it("opens #your-data as its own section and focuses it", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />, { route: "/settings#your-data" });

    const section = await screen.findByRole("region", { name: "Your data" });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(screen.getByRole("heading", { level: 1, name: "Your data" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.queryByTestId("zotero-section")).toBeNull();
  });

  it("splits Appearance and Language into separate entries", async () => {
    testAuth.authenticated = true;
    const { unmount } = renderWithProviders(<SettingsPage />, { route: "/settings#appearance" });
    expect(await screen.findByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Language" })).toBeNull();
    unmount();

    renderWithProviders(<SettingsPage />, { route: "/settings#language" });
    expect(await screen.findByRole("radiogroup", { name: "Language" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Language" })).toBeInTheDocument();
  });
});
