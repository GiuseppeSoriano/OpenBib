import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
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

  it("honours a stored dark preference on mount", () => {
    localStorage.setItem("openbib.theme", "dark");
    renderWithProviders(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
