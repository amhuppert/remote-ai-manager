// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DiffPanel from "./DiffPanel";
import type { SessionDiff } from "@/types";

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
    expect(screen.getByText("No changes")).toBeDefined();
    expect(
      screen.getByText("This session has no diff vs main yet."),
    ).toBeDefined();
  });

  it("renders panel header with totals (Req 5.1)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("Diff vs main")).toBeDefined();
    expect(screen.getByText("+15")).toBeDefined();
    // "-3" appears in both header and per-file stat, use container query
    const header = container.querySelector(".panel-header")!;
    expect(header.textContent).toContain("-3");
    expect(header.textContent).toContain("2 files");
  });

  it("renders file paths and per-file stats (Req 5.2)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("src/index.ts")).toBeDefined();
    expect(screen.getByText("README.md")).toBeDefined();
    // Per-file stats via container queries (avoid duplicate text matches)
    const stats = container.querySelectorAll(".diff-file-stat");
    expect(stats.length).toBe(2);
    expect(stats[0]!.textContent).toContain("+10");
    expect(stats[0]!.textContent).toContain("-3");
    expect(stats[1]!.textContent).toContain("+5");
    expect(stats[1]!.textContent).toContain("-0");
  });

  it("renders diff lines with correct type classes (Req 5.3)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const additions = container.querySelectorAll(".diff-line.addition");
    const deletions = container.querySelectorAll(".diff-line.deletion");
    const hunkHeaders = container.querySelectorAll(".diff-line.hunk-header");
    expect(additions.length).toBe(2); // "+const x = 1" and "+# README"
    expect(deletions.length).toBe(1); // "-const y = 2"
    expect(hunkHeaders.length).toBe(2); // Two hunk headers
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
    // All file headers should have collapsed class
    const collapsedHeaders = container.querySelectorAll(
      ".diff-file-header.collapsed",
    );
    expect(collapsedHeaders.length).toBe(2);
  });

  it("expands all files when expand button clicked after collapse (Req 5.4)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const collapseBtn = container.querySelector(
      '[title="Collapse all files"]',
    )!;
    const expandBtn = container.querySelector('[title="Expand all files"]')!;
    fireEvent.click(collapseBtn);
    fireEvent.click(expandBtn);
    const collapsedHeaders = container.querySelectorAll(
      ".diff-file-header.collapsed",
    );
    expect(collapsedHeaders.length).toBe(0);
  });

  it("toggles individual file collapse on header click (Req 5.4)", () => {
    const { container } = render(<DiffPanel diff={sampleDiff} />);
    const fileHeaders = container.querySelectorAll(".diff-file-header");
    // Click first file header to collapse it
    fireEvent.click(fileHeaders[0]!);
    expect(fileHeaders[0]!.classList.contains("collapsed")).toBe(true);
    // Second should remain expanded
    expect(fileHeaders[1]!.classList.contains("collapsed")).toBe(false);
    // Click again to expand
    fireEvent.click(fileHeaders[0]!);
    expect(fileHeaders[0]!.classList.contains("collapsed")).toBe(false);
  });

  it("renders file and hunk navigation buttons (Req 5.5)", () => {
    render(<DiffPanel diff={sampleDiff} />);
    expect(screen.getByText("Files")).toBeDefined();
    expect(screen.getByText("Changes")).toBeDefined();
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
