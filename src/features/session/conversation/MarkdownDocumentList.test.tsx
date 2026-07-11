// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MarkdownDocumentList from "./MarkdownDocumentList";
import type { MarkdownDocumentListItem } from "@/lib/documents/schemas";

const documents: MarkdownDocumentListItem[] = [
  {
    docPath: "docs/plan.md",
    title: "plan.md",
    origin: "edit",
    firstSeenAt: "2026-07-11T10:00:00.000Z",
    lastSeenAt: "2026-07-11T11:00:00.000Z",
    location: "worktree",
    registered: true,
    description: "Implementation plan",
  },
  {
    docPath: "/shared/runbook.md",
    title: "runbook.md",
    origin: "read",
    firstSeenAt: "2026-07-11T09:00:00.000Z",
    lastSeenAt: "2026-07-11T09:00:00.000Z",
    location: "external",
    registered: false,
    description: null,
  },
];

describe("MarkdownDocumentList", () => {
  it("renders paths, origin metadata, descriptions, and external state", () => {
    render(
      <MarkdownDocumentList
        documents={documents}
        activeDocPath="docs/plan.md"
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText("docs/plan.md")).toBeInTheDocument();
    expect(screen.getByText("Implementation plan")).toBeInTheDocument();
    expect(screen.getByText("EDITED")).toBeInTheDocument();
    expect(screen.getByText("EXTERNAL · READ")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open \/shared\/runbook\.md/i }),
    ).toBeEnabled();
  });

  it("opens the selected document", async () => {
    const onOpen = vi.fn();
    render(
      <MarkdownDocumentList
        documents={documents}
        activeDocPath={null}
        onOpen={onOpen}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /open docs\/plan\.md/i }),
    );
    expect(onOpen).toHaveBeenCalledWith(documents[0]);
  });

  it("renders loading, error, and empty states", () => {
    const { rerender } = render(
      <MarkdownDocumentList
        documents={[]}
        activeDocPath={null}
        onOpen={() => {}}
        loading
      />,
    );
    expect(screen.getByText("Loading Markdown documents…")).toBeInTheDocument();

    rerender(
      <MarkdownDocumentList
        documents={[]}
        activeDocPath={null}
        onOpen={() => {}}
        error="Could not load Markdown documents."
      />,
    );
    expect(
      screen.getByText("Could not load Markdown documents."),
    ).toBeInTheDocument();

    rerender(
      <MarkdownDocumentList
        documents={[]}
        activeDocPath={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("No Markdown documents")).toBeInTheDocument();
  });
});
