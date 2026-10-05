import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import PossibleVersionNote from "@/components/search/PossibleVersionNote";
import { resultElementId } from "@/lib/search-pages";

const version = { paper_group_key: "group:b", title: "A Comprehensive Survey on GNNs", provider_sources: [] };

afterEach(() => {
  document.getElementById(resultElementId("group:b"))?.remove();
});

describe("PossibleVersionNote", () => {
  it("scrolls to and focuses the related card, then reports it", () => {
    const onShow = vi.fn();
    const target = document.createElement("div");
    target.id = resultElementId("group:b");
    target.tabIndex = -1;
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    render(
      <I18nextProvider i18n={i18n}>
        <PossibleVersionNote versions={[version]} isShown={() => true} onShow={onShow} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Possible other version:")).toBeInTheDocument();
    expect(screen.getByText("A Comprehensive Survey on GNNs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show “A Comprehensive Survey on GNNs”" }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(target).toHaveFocus();
    expect(onShow).toHaveBeenCalledWith("group:b");
  });

  it("offers Show only for a result on screen", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PossibleVersionNote versions={[version]} isShown={() => false} onShow={vi.fn()} />
      </I18nextProvider>,
    );
    expect(screen.getByText("A Comprehensive Survey on GNNs")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing without versions", () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PossibleVersionNote versions={[]} isShown={() => true} onShow={vi.fn()} />
      </I18nextProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
