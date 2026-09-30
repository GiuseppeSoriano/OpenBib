import { testAuth, mockRefresh } from "@/test/auth-mock";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "@/pages/SettingsPage";
import api from "@/lib/api";
import { renderWithProviders } from "@/test/utils";
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
  it("theme segmented control sets and persists the preference", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    const segment = await screen.findByTestId("theme-segment");
    const { fireEvent } = await import("@testing-library/react");
    const darkBtn = Array.from(segment.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Dark"),
    )!;
    fireEvent.click(darkBtn);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("openbib.theme")).toBe("dark");
  });

  it("language segmented control switches and persists the language", async () => {
    testAuth.authenticated = true;
    renderWithProviders(<SettingsPage />);

    const segment = await screen.findByTestId("language-segment");
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const itBtn = Array.from(segment.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Italiano"),
    )!;
    fireEvent.click(itBtn);

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
