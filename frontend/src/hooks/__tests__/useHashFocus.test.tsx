import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { useHashFocus } from "@/hooks/useHashFocus";

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function ZoteroSection({ ready, withInput = true }: { ready?: boolean; withInput?: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useHashFocus("zotero", sectionRef, { ready, focus: inputRef });
  return (
    <section ref={sectionRef} aria-label="Zotero">
      {withInput && <input ref={inputRef} aria-label="API key" />}
    </section>
  );
}

function renderAt(route: string, ui = <ZoteroSection />) {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe("useHashFocus", () => {
  it("scrolls to the section and focuses the preferred element", async () => {
    renderAt("/settings#zotero");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "API key" })),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("falls back to focusing the section itself", async () => {
    renderAt("/settings#zotero", <ZoteroSection withInput={false} />);
    const section = screen.getByRole("region", { name: "Zotero" });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(section).toHaveAttribute("tabindex", "-1");
  });

  it("ignores other hashes", async () => {
    renderAt("/settings#your-data");
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("waits until the section is ready", async () => {
    const { rerender } = renderAt("/settings#zotero", <ZoteroSection ready={false} />);
    await nextFrame();
    expect(document.activeElement).toBe(document.body);

    rerender(
      <MemoryRouter initialEntries={["/settings#zotero"]}>
        <ZoteroSection ready />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "API key" })),
    );
  });
});
