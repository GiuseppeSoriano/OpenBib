import { describe, it, expect } from "vitest";
import { screen, act } from "@testing-library/react";
import i18n from "@/i18n";
import Layout from "@/components/Layout";
import MobileTabBar from "@/components/nav/MobileTabBar";
import { renderWithProviders } from "@/test/utils";

describe("i18n", () => {
  it("renders the navigation in English by default", async () => {
    renderWithProviders(<MobileTabBar />);
    expect((await screen.findAllByText("Search")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Collections")).length).toBeGreaterThan(0);
  });

  it("renders the navigation in Italian after switching language", async () => {
    renderWithProviders(<MobileTabBar />);
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect((await screen.findAllByText("Cerca")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Raccolte")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Libreria")).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe("it");
  });

  it("persists the chosen language for the next visit", async () => {
    renderWithProviders(<Layout />);
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(localStorage.getItem("openbib.lang")).toBe("it");
  });
});
