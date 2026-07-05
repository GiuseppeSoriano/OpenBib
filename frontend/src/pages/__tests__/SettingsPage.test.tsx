import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import SettingsPage from "@/pages/SettingsPage";
import { renderWithProviders } from "@/test/utils";
import type { ZoteroStatus } from "@/types";

const zoteroState: { status: ZoteroStatus } = {
  status: { connected: false, zotero_user_id: null, api_key_masked: null },
};

vi.mock("@/lib/api", () => ({
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
});

describe("SettingsPage — appearance", () => {
  it("theme segmented control sets and persists the preference", async () => {
    localStorage.setItem("access_token", "test-token");
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
    localStorage.setItem("access_token", "test-token");
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
    localStorage.setItem("access_token", "test-token");
    renderWithProviders(<SettingsPage />);

    const section = await screen.findByTestId("zotero-section");
    expect(section).toBeInTheDocument();
    expect(screen.getByText("Zotero API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "zotero.org/settings/keys" })).toHaveAttribute(
      "href",
      "https://www.zotero.org/settings/keys",
    );
  });

  it("shows the connected state with a masked key and disconnect action", async () => {
    zoteroState.status = {
      connected: true,
      zotero_user_id: "777",
      api_key_masked: "********efgh",
    };
    localStorage.setItem("access_token", "test-token");
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Connected to Zotero user 777")).toBeInTheDocument();
    expect(screen.getByText("********efgh")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByText("Zotero API key")).toBeNull();
  });
});
