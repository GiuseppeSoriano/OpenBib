import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import RegisterPage from "@/pages/RegisterPage";
import api from "@/lib/api";
import { renderWithProviders } from "@/test/utils";
import type { RegistrationStatus } from "@/types";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => Promise.reject(new Error("No session"))),
  setAccessToken: vi.fn(), setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn(), post: vi.fn() },
}));
const refetch = vi.fn();
vi.mock("@/lib/legal", () => ({ useLegalConfig: () => ({ data: { terms_version: "dev-1", privacy_version: "dev-1" }, refetch }) }));
let flow: RegistrationStatus;
const otp: RegistrationStatus = { stage: "otp", email_masked: "r***@example.com", expires_at: new Date(Date.now() + 1800000).toISOString(), otp_expires_at: new Date(Date.now() + 600000).toISOString(), resend_after: 60 };
const show = () => renderWithProviders(<Routes><Route path="/register" element={<RegisterPage />} /><Route path="/" element={<h1>Welcome home</h1>} /></Routes>, { route: "/register" });

beforeEach(() => {
  vi.clearAllMocks(); flow = { stage: "email" };
  vi.mocked(api.get).mockImplementation(async (url) => ({ data: url === "/auth/registration/status" ? flow : { id: "reader", email: "reader@example.com", display_name: "Reader" } }));
  vi.mocked(api.post).mockImplementation(async (url) => {
    if (url === "/auth/registration/start") flow = { ...otp };
    if (url === "/auth/registration/verify") flow = { ...otp, stage: "profile" };
    if (url === "/auth/registration/resend") flow = { ...otp };
    return { data: url === "/auth/registration/complete" ? { access_token: "memory-only" } : flow };
  });
});

async function profileFields() {
  fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Reader" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "a sufficiently long password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a sufficiently long password" } });
  fireEvent.click(screen.getByRole("checkbox"));
}

describe("mailbox-first registration", () => {
  it("requires matching confirmation and accepts an eight-character password", async () => {
    flow = { ...otp, stage: "profile" }; show();
    await profileFields();
    const password = screen.getByLabelText(/^Password/);
    const confirmation = screen.getByLabelText("Confirm password");
    expect(password).toHaveAttribute("minlength", "8");
    expect(confirmation).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(password, { target: { value: "Eight123" } });
    fireEvent.change(confirmation, { target: { value: "Different123" } });
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
    fireEvent.submit(password.closest("form")!);
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(confirmation, { target: { value: "Eight123" } });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Welcome home")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/registration/complete", expect.objectContaining({ password: "Eight123" }));
  });

  it("asks for the password only after OTP and starts an authenticated session", async () => {
    show();
    const email = await screen.findByLabelText("Email");
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    fireEvent.change(email, { target: { value: "reader@example.com" } });
    fireEvent.submit(email.closest("form")!);
    const code = await screen.findByLabelText("Verification code");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    fireEvent.change(code, { target: { value: "000042" } });
    fireEvent.submit(code.closest("form")!);
    await profileFields();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Welcome home")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/registration/verify", { code: "000042" });
    expect(api.post).toHaveBeenCalledWith("/auth/registration/complete", expect.objectContaining({ password: "a sufficiently long password", display_name: "Reader" }));
    expect(localStorage.getItem("access_token")).toBeNull();
    expect(sessionStorage.getItem("password")).toBeNull();
  });

  it("restores verification after a refresh and enforces the resend countdown", async () => {
    flow = { ...otp }; show();
    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send again in/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it("restores the verified stage without asking for another OTP", async () => {
    flow = { ...otp, stage: "profile" }; show();
    expect(await screen.findByLabelText(/^Password/)).toHaveAttribute("autocomplete", "new-password");
    expect(screen.queryByLabelText("Verification code")).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
  });

  it("shows an invalid code and retains the verification form", async () => {
    flow = { ...otp }; show();
    const code = await screen.findByLabelText("Verification code");
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 400, data: { detail: "registration_code_invalid" } } });
    fireEvent.change(code, { target: { value: "111111" } }); fireEvent.submit(code.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is incorrect");
    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
  });

  it.each(["expired", "locked"] as const)("offers a fresh registration when %s", async stage => {
    flow = { ...otp, stage }; show();
    expect(await screen.findByRole("button", { name: "Start registration again" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it("sends a new code only when the cooldown is over", async () => {
    flow = { ...otp, resend_after: 0 }; show();
    fireEvent.click(await screen.findByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/registration/resend"));
    expect(await screen.findByRole("button", { name: /Send again in/ })).toBeDisabled();
  });

  it("requires fresh consent when legal versions change", async () => {
    flow = { ...otp, stage: "profile" }; show(); await profileFields();
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { detail: "registration_legal_changed" } } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("terms or privacy notice have changed");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(refetch).toHaveBeenCalled();
  });
});
