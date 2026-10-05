import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import api, { zotero } from "@/lib/api";
import { renderWithProviders } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => Promise.resolve("memory-token")),
  setAccessToken: vi.fn(), setAuthFailureHandler: vi.fn(),
  default: {
    get: vi.fn(() => Promise.resolve({ data: { id: "reader", display_name: "Reader", email: "reader@example.com", legal_acceptance_required: true } })),
    post: vi.fn(() => Promise.resolve({ data: new Blob(["{}"], { type: "application/json" }) })),
  },
  papers: {}, library: {}, notes: {}, graph: {}, zotero: { getStatus: vi.fn() },
}));
vi.mock("@/lib/legal", () => ({ useLegalConfig: () => ({ data: { terms_version: "2", privacy_version: "2" } }) }));

describe("account access before legal acceptance", () => {
  it("allows export and deletion without enabling normal application features", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderWithProviders(<App />, { route: "/settings" });
    const password = await screen.findByLabelText("Password to confirm");
    expect(screen.queryByTestId("zotero-section")).toBeNull();
    const index = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(index).queryByRole("link", { name: "Integrations" })).toBeNull();
    expect(within(index).getByRole("link", { name: "Your data" })).toHaveAttribute("href", "/settings#your-data");
    expect(zotero.getStatus).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: "a sufficiently long password" } });
    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/users/me/export", { password: "a sufficiently long password" }, { responseType: "blob" }));
    fireEvent.change(screen.getByLabelText("Password to delete your account"), { target: { value: "a sufficiently long password" } });
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/users/me/delete", { password: "a sufficiently long password", confirmation: "DELETE" }));
    expect(api.post).not.toHaveBeenCalledWith("/users/me/legal-acceptance", expect.anything());
    vi.restoreAllMocks();
  });

  it("offers account tools and logout instead of forcing acceptance", async () => {
    renderWithProviders(<App />, { route: "/legal-review" });
    expect(await screen.findByRole("link", { name: "Your data" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();
  });
});
