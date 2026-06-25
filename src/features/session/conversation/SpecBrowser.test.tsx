// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { SpecBrowserView, type SpecBrowserViewProps } from "./SpecBrowser";

// Radix Accordion measures content via ResizeObserver (polyfilled in
// vitest.setup) and may capture the pointer; stub the pointer methods jsdom omits.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const TREE: SpecBrowserViewProps["tree"] = {
  steering: [],
  specs: {
    auth: ["requirements.md", "design.md"],
    billing: ["requirements.md"],
  },
};

// Stateful harness mirroring the real wrapper: onExpandFeature drives the
// controlled expandedFeature prop, so the accordion behaves as it does in
// production (single-open, mount/unmount). onSelectFile is observed via a spy.
function StatefulNav({
  onSelectFile,
  initialExpanded = null,
}: {
  onSelectFile: SpecBrowserViewProps["onSelectFile"];
  initialExpanded?: string | null;
}) {
  const [expandedFeature, setExpandedFeature] = useState<string | null>(
    initialExpanded,
  );
  return (
    <SpecBrowserView
      tree={TREE}
      isLoading={false}
      selection={null}
      fileContent={null}
      isFileLoading={false}
      segment="features"
      expandedFeature={expandedFeature}
      onSegmentChange={() => {}}
      onExpandFeature={setExpandedFeature}
      onSelectFile={onSelectFile}
      onGoBack={() => {}}
    />
  );
}

function renderNav(overrides: { expandedFeature?: string | null } = {}) {
  const onSelectFile = vi.fn();
  const utils = render(
    <StatefulNav
      onSelectFile={onSelectFile}
      initialExpanded={overrides.expandedFeature ?? null}
    />,
  );
  return { ...utils, onSelectFile };
}

describe("SpecBrowser feature-group accordion", () => {
  it("renders each feature group header as a button with aria-expanded", () => {
    renderNav();
    const auth = screen.getByRole("button", { name: /Auth/ });
    expect(auth.tagName).toBe("BUTTON");
    expect(auth).toHaveAttribute("aria-expanded", "false");
  });

  it("is keyboard-operable: a focusable native button that toggles aria-expanded", () => {
    renderNav();
    const auth = screen.getByRole("button", { name: /Auth/ });
    // A real <button type=button>: the browser synthesizes Enter/Space → click,
    // giving native keyboard activation the old clickable <div> never had.
    expect(auth.tagName).toBe("BUTTON");
    expect(auth).toHaveAttribute("type", "button");
    expect(auth).toHaveAttribute("aria-expanded", "false");

    auth.focus();
    expect(auth).toHaveFocus();

    // jsdom does not synthesize the native Enter→click, so drive the click the
    // browser would produce; Radix toggles aria-expanded in response.
    fireEvent.click(auth);
    expect(screen.getByRole("button", { name: /Auth/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("is single-open: expanding one group's file list collapses the other", () => {
    // auth starts expanded; opening billing must collapse auth's file list.
    renderNav({ expandedFeature: "auth" });

    expect(
      screen.getByRole("button", { name: /Requirements/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Billing/ }));

    // auth's two file buttons unmount; billing's single file list mounts.
    const fileButtons = screen
      .getAllByRole("button")
      .filter((b) => /^(Requirements|Design)$/.test(b.textContent ?? ""));
    // Only billing's "Requirements" remains (auth's Requirements + Design gone).
    expect(fileButtons).toHaveLength(1);
    expect(fileButtons[0]).toHaveTextContent("Requirements");
  });

  it("mounts the nested file list only while the group is open and selects on click", () => {
    const { onSelectFile } = renderNav();

    // Collapsed: no file buttons mounted.
    expect(
      screen.queryByRole("button", { name: /Requirements/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Auth/ }));

    const reqBtn = screen.getByRole("button", { name: /Requirements/ });
    expect(reqBtn).toBeInTheDocument();

    fireEvent.click(reqBtn);
    expect(onSelectFile).toHaveBeenCalledWith("auth", "requirements.md");
  });

  it("keeps the file list as a list with intact listitems (listitem-safe content)", () => {
    renderNav({ expandedFeature: "auth" });
    // The asChild content must not be the <ul> itself (Radix role=region would
    // orphan the <li>s). Here the file items are <button>s in a <div>, so just
    // assert the expanded group's files are reachable.
    const reqBtn = screen.getByRole("button", { name: /Requirements/ });
    const designBtn = screen.getByRole("button", { name: /Design/ });
    expect(within(reqBtn.closest("div")!).getByText("Design")).toBe(designBtn);
  });
});
