import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { VerifyEmailPage, ResetPasswordPage, CheckEmailPage, ForgotPasswordPage } from "@/pages/AccountLifecyclePages";
import api from "@/lib/api";
import { renderWithProviders } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => Promise.reject(new Error("No session"))),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: {
    post: vi.fn(() => Promise.resolve({ data: { access_token: "memory-only" } })),
    get: vi.fn(() => Promise.resolve({ data: { id: "reader", email: "reader@example.com" } })),
  },
}));

describe("account lifecycle pages", () => {
  it("retires verification links without asking for another password", async () => {
    window.history.replaceState(null, "", "/verify-email#token=mailbox-token");
    renderWithProviders(<VerifyEmailPage />);
    expect(await screen.findByRole("link", { name: "Start registration again" })).toHaveAttribute("href", "/register");
    expect(window.location.hash).toBe("");
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("offers password reset without storing the fragment token", async () => {
    window.history.replaceState(null, "", "/reset-password#token=reset-token");
    renderWithProviders(<ResetPasswordPage />);
    const password = await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");
    expect(password).toHaveAttribute("minlength", "8");
    fireEvent.change(password, { target: { value: "another sufficiently long password" } });
    fireEvent.submit(password.closest("form")!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/password/reset", { token: "reset-token", new_password: "another sufficiently long password" }));
  });

  it("frames each page in a main landmark with a home link and one heading", async () => {
    renderWithProviders(<ForgotPasswordPage />);
    const main = await screen.findByRole("main");
    expect(main).toContainElement(screen.getByRole("heading", { level: 1, name: "Forgot password?" }));
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "OpenBib home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  });

  it("announces a failed reset request", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error("offline"));
    renderWithProviders(<ForgotPasswordPage />);
    const email = await screen.findByLabelText("Email");
    fireEvent.change(email, { target: { value: "reader@example.com" } });
    fireEvent.submit(email.closest("form")!);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("redirects the old check-email flow to OTP registration", async () => {
    renderWithProviders(<CheckEmailPage />);
    expect(await screen.findByRole("link", { name: "Start registration again" })).toHaveAttribute("href", "/register");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
