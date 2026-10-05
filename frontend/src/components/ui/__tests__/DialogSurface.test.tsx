import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState, type ReactElement, type ReactNode } from "react";
import DialogSurface from "@/components/ui/DialogSurface";
import Menu from "@/components/ui/Menu";

const extraNodes: HTMLElement[] = [];

function addBodyChild(attrs: Record<string, string> = {}) {
  const node = document.createElement("div");
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  document.body.appendChild(node);
  extraNodes.push(node);
  return node;
}

/** Renders into a `#root` container, like the real app. */
function renderInRoot(ui: ReactElement) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  return { root, ...render(ui, { container: root }) };
}

afterEach(() => {
  for (const node of extraNodes.splice(0)) node.remove();
});

interface HarnessProps {
  onClose?: () => void;
  closeOnOverlay?: boolean;
  withFallback?: boolean;
  children?: ReactNode;
}

function Harness({ onClose, closeOnOverlay, withFallback, children }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [showTrigger, setShowTrigger] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>
        Page
      </h1>
      {showTrigger && (
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
      )}
      {open && (
        <DialogSurface
          labelledBy="dialog-title"
          overlayClassName="overlay"
          className="dialog"
          closeOnOverlay={closeOnOverlay}
          fallbackFocus={withFallback ? () => headingRef.current : undefined}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <h2 id="dialog-title">Test dialog</h2>
          <button type="button">First</button>
          {children}
          <button type="button" onClick={() => setShowTrigger(false)}>
            Remove trigger
          </button>
          <button type="button">Last</button>
        </DialogSurface>
      )}
    </>
  );
}

async function openHarness(props: HarnessProps = {}) {
  const user = userEvent.setup();
  const view = renderInRoot(<Harness {...props} />);
  const trigger = screen.getByRole("button", { name: "Open" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Test dialog" });
  return { ...view, user, trigger, dialog };
}

describe("DialogSurface", () => {
  it("is a named modal dialog portaled out of #root and focused on open", async () => {
    const { root, dialog } = await openHarness();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(root.contains(dialog)).toBe(false);
    expect(document.activeElement).toBe(dialog);
  });

  it("focuses initialFocusRef on open", () => {
    function WithInitialFocus() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <DialogSurface
          labelledBy="named"
          overlayClassName="overlay"
          className="dialog"
          initialFocusRef={ref}
          onClose={() => {}}
        >
          <h2 id="named">Named</h2>
          <button type="button">One</button>
          <button type="button" ref={ref}>
            Two
          </button>
        </DialogSurface>
      );
    }
    renderInRoot(<WithInitialFocus />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Two" }));
  });

  it("wraps Tab and Shift+Tab inside the dialog", async () => {
    const { user } = await openHarness();
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    act(() => last.focus());
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const onClose = vi.fn();
    const { user, trigger } = await openHarness({ onClose });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("makes the background inert and locks scrolling only while open", async () => {
    const live = addBodyChild({ "data-live-layer": "" });
    const sibling = addBodyChild();
    const alreadyInert = addBodyChild({ inert: "" });
    const { root, dialog, user } = await openHarness();

    expect(root).toHaveAttribute("inert");
    expect(sibling).toHaveAttribute("inert");
    expect(live).not.toHaveAttribute("inert");
    expect(dialog.parentElement).not.toHaveAttribute("inert");
    expect(document.documentElement).toHaveClass("has-modal");

    await user.keyboard("{Escape}");
    expect(root).not.toHaveAttribute("inert");
    expect(sibling).not.toHaveAttribute("inert");
    expect(alreadyInert).toHaveAttribute("inert");
    expect(document.documentElement).not.toHaveClass("has-modal");
  });

  it("still closes on Escape after focus fell back to the body", async () => {
    const onClose = vi.fn();
    const { dialog } = await openHarness({ onClose });
    act(() => dialog.blur());
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves Escape to the dialog when a page menu is still open behind it", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Menu button="Options">
            <button type="button" role="menuitem">
              Item
            </button>
          </Menu>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <DialogSurface
              labelledBy="menu-dialog-title"
              overlayClassName="overlay"
              className="dialog"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            >
              <h2 id="menu-dialog-title">Menu dialog</h2>
            </DialogSurface>
          )}
        </>
      );
    }
    renderInRoot(<Page />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // Keyboard activation: no outside mousedown, so the menu stays open.
    act(() => screen.getByRole("button", { name: "Open" }).focus());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Menu dialog" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lets an autoFocus child keep focus and still returns focus to the trigger", async () => {
    const { user, trigger } = await openHarness({
      children: <input aria-label="Name" autoFocus />,
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores an Escape that a child already handled", async () => {
    const onClose = vi.fn();
    const { user } = await openHarness({
      onClose,
      children: (
        <input
          aria-label="Draft"
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        />
      ),
    });
    await user.click(screen.getByRole("textbox", { name: "Draft" }));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes only the top dialog when stacked", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    function Stacked() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      if (!outer) return null;
      return (
        <DialogSurface
          labelledBy="outer-title"
          overlayClassName="overlay"
          className="dialog"
          onClose={() => {
            closeOuter();
            setOuter(false);
          }}
        >
          <h2 id="outer-title">Outer</h2>
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
          {inner && (
            <DialogSurface
              labelledBy="inner-title"
              overlayClassName="overlay"
              className="dialog"
              onClose={() => {
                closeInner();
                setInner(false);
              }}
            >
              <h2 id="inner-title">Inner</h2>
              <button type="button">Inner action</button>
            </DialogSurface>
          )}
        </DialogSurface>
      );
    }
    const user = userEvent.setup();
    renderInRoot(<Stacked />);
    const opener = screen.getByRole("button", { name: "Open inner" });
    await user.click(opener);
    const outerDialog = screen.getByRole("dialog", { name: "Outer" });
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeInTheDocument();
    expect(outerDialog.parentElement).toHaveAttribute("inert");

    // Tab inside the inner dialog stays there; the outer one must not react.
    const innerAction = screen.getByRole("button", { name: "Inner action" });
    act(() => innerAction.focus());
    await user.tab();
    expect(document.activeElement).toBe(innerAction);

    await user.keyboard("{Escape}");
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(outerDialog.parentElement).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(opener);
    expect(document.documentElement).toHaveClass("has-modal");

    await user.keyboard("{Escape}");
    expect(closeOuter).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveClass("has-modal");
  });

  it("closes on an overlay click but not on a drag that started inside", async () => {
    const onClose = vi.fn();
    const { dialog } = await openHarness({ onClose });
    const overlay = dialog.parentElement!;

    fireEvent.pointerDown(dialog);
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open on overlay clicks when closeOnOverlay is false", async () => {
    const onClose = vi.fn();
    const { dialog } = await openHarness({ onClose, closeOnOverlay: false });
    const overlay = dialog.parentElement!;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pulls stray focus back into the dialog", async () => {
    const { dialog } = await openHarness();
    act(() => screen.getByRole("heading", { name: "Page" }).focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("uses fallbackFocus when the trigger was unmounted", async () => {
    const { user } = await openHarness({ withFallback: true });
    await user.click(screen.getByRole("button", { name: "Remove trigger" }));
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Page" }));
  });

  it("keeps its focus and inert bookkeeping through StrictMode effect replays", async () => {
    const user = userEvent.setup();
    const { root } = renderInRoot(
      <StrictMode>
        <Harness>
          <input aria-label="Name" autoFocus />
        </Harness>
      </StrictMode>,
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    // The replayed cleanup must not bounce focus to the trigger and back.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    expect(root).toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(root).not.toHaveAttribute("inert");
    expect(document.documentElement).not.toHaveClass("has-modal");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes without throwing when the trigger is gone and there is no fallback", async () => {
    const { user } = await openHarness();
    await user.click(screen.getByRole("button", { name: "Remove trigger" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
