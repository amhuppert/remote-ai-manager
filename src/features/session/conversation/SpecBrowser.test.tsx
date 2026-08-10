// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { SpecBrowserView, type SpecBrowserViewProps } from "./SpecBrowser";

// Radix Accordion measures content via ResizeObserver (polyfilled in
// vitest.jsdom.setup) and may capture the pointer; stub the pointer methods jsdom omits.
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
}: {
  onSelectFile: SpecBrowserViewProps["onSelectFile"];
}) {
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
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

function renderNav() {
  const onSelectFile = vi.fn();
  const utils = render(<StatefulNav onSelectFile={onSelectFile} />);
  return { ...utils, onSelectFile };
}

describe("SpecBrowser file content", () => {
  function renderFile(overrides: Partial<SpecBrowserViewProps> = {}) {
    return render(
      <SpecBrowserView
        tree={TREE}
        isLoading={false}
        selection={{ category: "auth", file: "requirements.md" }}
        fileContent={"# Requirements\n\nThe body of the spec."}
        isFileLoading={false}
        segment="features"
        expandedFeature={null}
        onSegmentChange={() => {}}
        onExpandFeature={() => {}}
        onSelectFile={() => {}}
        onGoBack={() => {}}
        {...overrides}
      />,
    );
  }

  it("renders the selected file through the MarkdownViewport document adapter", async () => {
    const { container } = renderFile();

    await waitFor(() => {
      expect(
        container.querySelector('[data-markdown-intent="document"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector("[data-markdown-viewport]")).not.toBeNull();
    expect(
      await screen.findByRole("heading", { name: "Requirements" }),
    ).toBeInTheDocument();
    // The spec browser is a plain document viewer — it does not annotate, so no
    // source-position metadata is stamped.
    expect(container.querySelector("[data-markdown-source-mapped]")).toBeNull();
  });

  it("shows the empty message when the selected file has no content", () => {
    const { container } = renderFile({
      fileContent: null,
      isFileLoading: false,
    });
    const viewport = container.querySelector("[data-markdown-viewport]");
    expect(viewport).not.toBeNull();
    expect(viewport).toHaveTextContent("File not found.");
  });
});

describe("SpecBrowser feature-group accordion", () => {
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
});
