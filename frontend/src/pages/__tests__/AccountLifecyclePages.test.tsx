import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { VerifyEmailPage, ResetPasswordPage, CheckEmailPage } from "@/pages/AccountLifecyclePages";
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
  it("keeps the verification token in memory and submits the final password", async () => {
    window.history.replaceState(null, "", "/verify-email#token=mailbox-token");
    renderWithProviders(<VerifyEmailPage />);
    const password = await screen.findByLabelText("Password");
    expect(window.location.hash).toBe("");
    fireEvent.change(password, { target: { value: "a sufficiently long password" } });
    fireEvent.submit(password.closest("form")!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/verify-email", { token: "mailbox-token", new_password: "a sufficiently long password" }));
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("offers password reset without storing the fragment token", async () => {
    window.history.replaceState(null, "", "/reset-password#token=reset-token");
    renderWithProviders(<ResetPasswordPage />);
    const password = await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");
    expect(password).toHaveAttribute("minlength", "15");
    fireEvent.change(password, { target: { value: "another sufficiently long password" } });
    fireEvent.submit(password.closest("form")!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/password/reset", { token: "reset-token", new_password: "another sufficiently long password" }));
  });

  it("allows a generic verification resend", async () => {
    renderWithProviders(<CheckEmailPage />);
    const email = await screen.findByLabelText("Email");
    fireEvent.change(email, { target: { value: "reader@example.com" } });
    fireEvent.submit(email.closest("form")!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/email/resend", { email: "reader@example.com", locale: "en" }));
  });
});
