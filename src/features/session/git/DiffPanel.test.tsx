// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DiffPanel from "@/features/session/git/DiffPanel";
import type { SessionDiff } from "@/lib/git/schemas";

// ===========================================================================
// 4.3 – DiffPanel rendering (Req 5.1–5.6)
// ===========================================================================

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

const sampleDiff: SessionDiff = {
  files: [
    {
      filePath: "src/index.ts",
      additions: 10,
      deletions: 3,
      hunks: [
        {
          header: "@@ -1,5 +1,7 @@",
          lines: [
            { type: "hunk-header", content: "@@ -1,5 +1,7 @@" },
            { type: "context", content: " import { foo } from 'bar'" },
            { type: "add", content: "+const x = 1" },
            { type: "remove", content: "-const y = 2" },
          ],
        },
      ],
    },
    {
      filePath: "README.md",
      additions: 5,
      deletions: 0,
      hunks: [
        {
          header: "@@ -0,0 +1,5 @@",
          lines: [
            { type: "hunk-header", content: "@@ -0,0 +1,5 @@" },
            { type: "add", content: "+# README" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 15,
  totalDeletions: 3,
};

describe("DiffPanel", () => {
  it("renders empty state when no diff files (Req 5.6)", () => {
    render(<DiffPanel diff={emptyDiff} />);
    // With no diff files, DiffPanel defaults to "Commits" tab
    // Click the "Uncommitted" tab to see the empty diff state
    fireEvent.click(screen.getByText("Uncommitted"));
    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(
      screen.getByText("This session has no uncommitted changes."),
    ).toBeInTheDocument();
  });

  it("renders panel header with totals (Req 5.1)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("Diff vs main")).toBeInTheDocument();
    expect(screen.getByText("+15")).toBeInTheDocument();
    // "-3" appears in both header and per-file stat, use container query
    const header = container.querySelector(".panel-header")!;
    expect(header.textContent).toContain("-3");
    expect(header.textContent).toContain("2 files");
  });

  it("renders file paths and per-file stats (Req 5.2)", () => {
    render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // Per-file additions/deletions render (additions + file-2 deletions are
    // unique text, so assert on content rather than appearance classes).
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("-0")).toBeInTheDocument();
  });

  it("renders diff line content for each line type (Req 5.3)", () => {
    render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("+const x = 1")).toBeInTheDocument();
    expect(screen.getByText("-const y = 2")).toBeInTheDocument();
    expect(screen.getByText("+# README")).toBeInTheDocument();
    expect(screen.getByText("@@ -1,5 +1,7 @@")).toBeInTheDocument();
    expect(screen.getByText("@@ -0,0 +1,5 @@")).toBeInTheDocument();
  });

  it("renders collapse/expand toolbar buttons (Req 5.4)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const collapseBtn = container.querySelector('[title="Collapse all files"]');
    const expandBtn = container.querySelector('[title="Expand all files"]');
    expect(collapseBtn).not.toBeNull();
    expect(expandBtn).not.toBeNull();
  });

  it("collapses all files when collapse button clicked (Req 5.4)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const collapseBtn = container.querySelector(
      '[title="Collapse all files"]',
    )!;
    fireEvent.click(collapseBtn);
    // All file headers carry the collapsed state attribute.
    expect(container.querySelectorAll('[data-collapsed="true"]').length).toBe(
      2,
    );
  });

  it("expands all files when expand button clicked after collapse (Req 5.4)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const collapseBtn = container.querySelector(
      '[title="Collapse all files"]',
    )!;
    const expandBtn = container.querySelector('[title="Expand all files"]')!;
    fireEvent.click(collapseBtn);
    fireEvent.click(expandBtn);
    expect(container.querySelectorAll('[data-collapsed="true"]').length).toBe(
      0,
    );
  });

  it("toggles individual file collapse on header click (Req 5.4)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const fileHeaders =
      container.querySelectorAll<HTMLElement>("[data-collapsed]");
    // Click first file header to collapse it
    fireEvent.click(fileHeaders[0]!);
    expect(fileHeaders[0]!.getAttribute("data-collapsed")).toBe("true");
    // Second should remain expanded
    expect(fileHeaders[1]!.getAttribute("data-collapsed")).toBe("false");
    // Click again to expand
    fireEvent.click(fileHeaders[0]!);
    expect(fileHeaders[0]!.getAttribute("data-collapsed")).toBe("false");
  });

  it("renders file and hunk navigation buttons (Req 5.5)", () => {
    render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
  });

  it("shows '1 file' singular when only one file (Req 5.1)", () => {
    const singleFileDiff: SessionDiff = {
      files: [sampleDiff.files[0]!],
      totalAdditions: 10,
      totalDeletions: 3,
    };
    const { container } = render(<DiffPanel diff={singleFileDiff} />);
    const header = container.querySelector(".panel-header")!;
    expect(header.textContent).toContain("1 file");
    expect(header.textContent).not.toContain("1 files");
  });
});
