import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CollectionSharing from "../CollectionSharing";
import api from "@/lib/api";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
let enabled = false;
const url = "http://localhost:3000/collections/c1#share=" + "a".repeat(43);
let members: { user_id: string; display_name: string; email: string; role: string }[] = [];
const close = vi.fn();
function renderSharing() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><CollectionSharing collectionId="c1" onClose={close} /></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); enabled = false; members = [];
  vi.mocked(api.get).mockImplementation(async (path) => ({ data: path?.endsWith("/members") ? members : { enabled, url: enabled ? url : null } }));
  vi.mocked(api.put).mockImplementation(async () => { enabled = true; return { data: {} }; });
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path?.endsWith("/members")) members = [{ user_id: "u2", display_name: "Collaborator", email: (body as { email: string }).email, role: "editor" }];
    return { data: {} };
  });
  vi.mocked(api.delete).mockImplementation(async (path) => { if (path?.endsWith("/read-link")) enabled = false; else members = []; return { data: {} }; });
});
describe("Collection sharing", () => {
  it("enables and copies the link without rotating it", async () => {
    const user = userEvent.setup(); renderSharing();
    await screen.findByText("Link disabled");
    await user.click(screen.getByRole("button", { name: "Enable read-only link" }));
    expect(await screen.findByDisplayValue(url)).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(url);
    expect(api.post).not.toHaveBeenCalled();
  });
  it("confirms revocation and supports cancellation", async () => {
    enabled = true; renderSharing();
    await screen.findByDisplayValue(url);
    fireEvent.click(screen.getByRole("button", { name: "Disable link" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disable link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Link disabled");
    expect(api.delete).toHaveBeenCalledWith("/collections/c1/read-link");
  });
  it("adds an email and removes a collaborator after confirmation", async () => {
    renderSharing(); await screen.findByText("No collaborators yet.");
    fireEvent.change(screen.getByLabelText("Account email"), { target: { value: "editor@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow editing" }));
    expect(await screen.findByText("editor@example.com")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/collections/c1/members", { email: "editor@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("No collaborators yet.");
  });
  it("shows unavailable-account errors without closing the form", async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { status: 400 } });
    renderSharing(); await screen.findByText("Link disabled");
    fireEvent.change(screen.getByLabelText("Account email"), { target: { value: "missing@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow editing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Verified account unavailable");
    expect(screen.getByLabelText("Account email")).toHaveValue("missing@example.com");
  });
  it("traps keyboard focus and closes on Escape", async () => {
    const user = userEvent.setup(); renderSharing(); await screen.findByText("Link disabled");
    const first = screen.getByRole("button", { name: "Close" });
    first.focus(); await user.tab({ shift: true });
    expect(screen.getByLabelText("Account email")).toHaveFocus();
    await user.tab(); expect(first).toHaveFocus();
    await user.keyboard("{Escape}"); await waitFor(() => expect(close).toHaveBeenCalled());
  });
});
