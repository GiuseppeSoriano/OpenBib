import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { ToastProvider, useToast } from "@/components/ui/Toast";

function Trigger() {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast("Saved to your library", "success")}>
      Notify
    </button>
  );
}

describe("ToastProvider", () => {
  it("renders toasts in a live layer outside the app root", () => {
    const { container } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-live-layer");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.parentElement).toBe(document.body);
    expect(container.contains(region)).toBe(false);
    expect(region).toHaveTextContent("Saved to your library");
  });

  it("labels the dismiss button in the current language", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("it");
    });
    fireEvent.click(screen.getByRole("button", { name: "Chiudi notifica" }));
    expect(screen.queryByText("Saved to your library")).toBeNull();
  });
});
