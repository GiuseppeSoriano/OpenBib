import { mockRefresh, testAuth } from "@/test/auth-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ZoteroSyncButton from "@/components/zotero/ZoteroSyncButton";
import { zotero } from "@/lib/api";
import { renderWithProviders } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn(() =>
      Promise.resolve({ data: { id: "u1", email: "me@example.com", display_name: "Me" } }),
    ),
  },
  zotero: { getStatus: vi.fn(), syncCollection: vi.fn(), syncLibrary: vi.fn() },
  library: {},
  papers: {},
  notes: {},
  graph: {},
}));

const connected = { connected: true, zotero_user_id: "7", api_key_masked: "****abcd" };
const report = { zotero_collection_key: "K", items_created: 2, items_updated: 1, items_skipped: 3, failures: [] };

afterEach(() => {
  testAuth.authenticated = false;
  vi.mocked(zotero.getStatus).mockReset();
  vi.mocked(zotero.syncCollection).mockReset();
  vi.mocked(zotero.syncLibrary).mockReset();
});

describe("ZoteroSyncButton", () => {
  it("renders nothing for anonymous visitors", async () => {
    const { container } = renderWithProviders(<ZoteroSyncButton collectionId="c1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(zotero.getStatus).not.toHaveBeenCalled();
  });

  it("links to the Zotero settings with a visible hint when disconnected", async () => {
    testAuth.authenticated = true;
    vi.mocked(zotero.getStatus).mockResolvedValue({ connected: false, zotero_user_id: null, api_key_masked: null });
    renderWithProviders(<ZoteroSyncButton collectionId="c1" headers={{ "X-Collection-Share-Token": "t" }} />, {
      route: "/collections/c1#share=t",
    });

    const link = await screen.findByRole("link", { name: "Connect Zotero to sync" });
    expect(link).toHaveAttribute("href", "/settings#zotero");
    const hint = screen.getByText("Zotero isn’t connected. Add your API key in Settings.");
    expect(hint).toBeVisible();
    expect(link).toHaveAttribute("aria-describedby", hint.id);
    expect(link).not.toHaveAttribute("title");
    expect(screen.queryByRole("button", { name: /Sync to Zotero/ })).toBeNull();
  });

  it("syncs a collection with its access headers and reports the result", async () => {
    const user = userEvent.setup();
    testAuth.authenticated = true;
    vi.mocked(zotero.getStatus).mockResolvedValue(connected);
    vi.mocked(zotero.syncCollection).mockResolvedValue(report);
    const headers = { "X-Collection-Share-Token": "t" };
    renderWithProviders(<ZoteroSyncButton collectionId="c1" headers={headers} />);

    await user.click(await screen.findByRole("button", { name: "Sync to Zotero" }));

    expect(zotero.syncCollection).toHaveBeenCalledWith("c1", headers);
    expect(await screen.findByText("Zotero: 2 created, 1 updated, 3 unchanged")).toBeInTheDocument();
  });

  it("syncs the Library without a collection id", async () => {
    const user = userEvent.setup();
    testAuth.authenticated = true;
    vi.mocked(zotero.getStatus).mockResolvedValue(connected);
    vi.mocked(zotero.syncLibrary).mockResolvedValue(report);
    renderWithProviders(<ZoteroSyncButton />);

    await user.click(await screen.findByRole("button", { name: "Sync to Zotero" }));
    expect(zotero.syncLibrary).toHaveBeenCalled();
    expect(zotero.syncCollection).not.toHaveBeenCalled();
  });

  it("explains a rejected key and a coded failure", async () => {
    const user = userEvent.setup();
    testAuth.authenticated = true;
    vi.mocked(zotero.getStatus).mockResolvedValue(connected);
    vi.mocked(zotero.syncLibrary)
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockRejectedValueOnce({ response: { status: 500 } });
    renderWithProviders(<ZoteroSyncButton />);

    await user.click(await screen.findByRole("button", { name: "Sync to Zotero" }));
    expect(await screen.findByText("Connect Zotero in Settings first")).toBeInTheDocument();
    await waitFor(() => expect(zotero.getStatus).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Sync to Zotero" }));
    expect(await screen.findByText("Zotero sync failed")).toBeInTheDocument();
  });
});
