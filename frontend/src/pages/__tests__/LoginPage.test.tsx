import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LoginPage from "@/pages/LoginPage";

const login = vi.fn();
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ login }) }));

function show(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/login", state }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<h1>Home page</h1>} />
        <Route path="/library" element={<h1>Library page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fill() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a sufficiently long password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => login.mockReset());

describe("sign-in page", () => {
  it("frames the form in a main landmark with a home link and a serif title", () => {
    show();
    const main = screen.getByRole("main");
    expect(main).toContainElement(screen.getByRole("heading", { level: 1, name: "Welcome back" }));
    expect(screen.getByRole("link", { name: "OpenBib home" })).toHaveAttribute("href", "/");
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/register");
  });

  it("announces a failed sign-in", async () => {
    login.mockRejectedValueOnce(new Error("401"));
    show();
    fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("returns to the requested page after signing in", async () => {
    login.mockResolvedValueOnce(undefined);
    show({ returnTo: "/library" });
    fill();
    await waitFor(() => expect(login).toHaveBeenCalledWith("reader@example.com", "a sufficiently long password"));
    expect(await screen.findByRole("heading", { name: "Library page" })).toBeInTheDocument();
  });
});
