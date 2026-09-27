import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SecuritySettings from "../SecuritySettings";
import api from "@/lib/api";

const clearSession = vi.hoisted(() => vi.fn());
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { email: "reader@example.com", email_verified: true }, clearSession }) }));
vi.mock("@/lib/api", () => ({ default: { post: vi.fn() } }));

function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><SecuritySettings /></QueryClientProvider>);
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});

describe("compact security settings", () => {
  it("shows account summaries and keeps credentials hidden until an action is selected", () => {
    show();
    expect(screen.getByRole("region", { name: "Sign-in and security" })).toBeInTheDocument();
    expect(screen.getByText("reader@example.com")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Logout" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("opens only the email form, discards credentials on cancel, and restores focus", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    expect(screen.getByLabelText("New email")).toHaveFocus();
    expect(screen.queryByLabelText("New password")).toBeNull();
    fill("New email", "new@example.com"); fill("Current password", "private-password");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Change email" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("Current password")).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("sends the unchanged email-change contract and returns to the summary with feedback", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    fill("New email", "new@example.com"); fill("Current password", "private-password");
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation email" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/users/me/email-change", { email: "new@example.com", password: "private-password", locale: "en" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Check the new email");
    expect(screen.getByRole("button", { name: "Change email" })).toHaveFocus();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("requires matching passwords before sending a password change and revokes the local session", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByLabelText("Current password")).toHaveAttribute("autocomplete", "current-password");
    fill("Current password", "previous-password");
    fill("New password", "NewPass8"); fill("Confirm new password", "Mismatch");
    fireEvent.blur(screen.getByLabelText("Confirm new password"));
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(screen.getByRole("button", { name: "Update password" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Change password" }));
    expect(api.post).not.toHaveBeenCalled();
    fill("Confirm new password", "NewPass8");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/users/me/password", { current_password: "previous-password", new_password: "NewPass8" }));
    await waitFor(() => expect(clearSession).toHaveBeenCalledOnce());
  });

  it("does not sign out until the explicit confirmation is submitted", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
    expect(screen.getByText(/This session will also end/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign out all devices" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/logout-all"));
    await waitFor(() => expect(clearSession).toHaveBeenCalledOnce());
  });

  it("retains the form on server failure and shows an accessible error", async () => {
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 401 } });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    fill("New email", "new@example.com"); fill("Current password", "wrong-password");
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("current password is incorrect");
    expect(screen.getByLabelText("New email")).toHaveValue("new@example.com");
    expect(screen.getByRole("button", { name: "Send confirmation email" })).toBeEnabled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("prevents duplicate submissions and leaving a pending operation", async () => {
    let complete!: (value: { data: object }) => void;
    vi.mocked(api.post).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    fill("New email", "new@example.com"); fill("Current password", "private-password");
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation email" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("Current password")).toBeDisabled();
    complete({ data: {} });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledOnce();
  });
});
