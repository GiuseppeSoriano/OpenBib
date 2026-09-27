import { describe, it, expect } from "vitest";
import { act, screen, fireEvent } from "@testing-library/react";
import i18n from "@/i18n";
import ThemeToggle from "@/components/ui/ThemeToggle";
import { renderWithProviders } from "@/test/utils";

describe("ThemeToggle", () => {
  it("cycles system → light → dark and persists the preference", () => {
    renderWithProviders(<ThemeToggle />);
    const btn = screen.getByTestId("theme-toggle");

    // No stored preference: starts on "system" (resolves light in tests).
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(btn); // system → light
    expect(localStorage.getItem("openbib.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(btn); // light → dark
    expect(localStorage.getItem("openbib.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("names the current theme in the UI language", async () => {
    renderWithProviders(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(screen.getByRole("button", { name: "Tema: Sistema" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("theme-toggle"));
    expect(screen.getByRole("button", { name: "Tema: Chiaro" })).toBeInTheDocument();
  });

  it("honours a stored dark preference on mount", () => {
    localStorage.setItem("openbib.theme", "dark");
    renderWithProviders(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
