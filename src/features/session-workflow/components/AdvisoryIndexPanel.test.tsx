// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { GraphWorkflowAdvisoryIndexEntry } from "@/lib/workflow-graph/schemas";
import AdvisoryIndexPanel from "./AdvisoryIndexPanel";

function entry(
  overrides: Partial<GraphWorkflowAdvisoryIndexEntry> = {},
): GraphWorkflowAdvisoryIndexEntry {
  return {
    identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
    kind: "plan",
    title: "The plan skips the migration backfill",
    contextId: "ctx-schema",
    ...overrides,
  };
}

const contextTitles = {
  "ctx-schema": "Schema and migrations",
  "ctx-ui": "Execution UI",
};

function renderPanel(
  index: readonly GraphWorkflowAdvisoryIndexEntry[],
  onOpenOrigin = vi.fn(),
) {
  render(
    <AdvisoryIndexPanel
      index={index}
      contextTitles={contextTitles}
      onOpenOrigin={onOpenOrigin}
    />,
  );
  return { onOpenOrigin };
}

function entryRows(): HTMLElement[] {
  return screen.getAllByTestId("advisory-index-entry");
}

describe("AdvisoryIndexPanel (R9.4)", () => {
  it("aggregates plan and out_of_scope advisories across contexts and rounds", () => {
    renderPanel([
      entry({
        contextId: "ctx-schema",
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        kind: "plan",
        title: "The plan skips the migration backfill",
      }),
      entry({
        contextId: "ctx-schema",
        identity: { roundSeq: 3, assignmentId: "general", ordinal: 2 },
        kind: "out_of_scope",
        title: "The legacy importer is unreachable",
      }),
      entry({
        contextId: "ctx-ui",
        identity: { roundSeq: 1, assignmentId: "design", ordinal: 1 },
        kind: "plan",
        title: "Two tabs claim the same shortcut",
      }),
    ]);

    // One list, spanning two contexts and three rounds — the point of the
    // index is that none of this needs a round to be opened.
    expect(
      entryRows().map((row) => row.getAttribute("data-context-id")),
    ).toEqual(["ctx-schema", "ctx-schema", "ctx-ui"]);
    expect(
      screen.getByText("The plan skips the migration backfill"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The legacy importer is unreachable"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Two tabs claim the same shortcut"),
    ).toBeInTheDocument();
  });

  it("renders each entry's kind as an informational chip, never the failure tone", () => {
    renderPanel([
      entry({ kind: "plan" }),
      entry({
        kind: "out_of_scope",
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
      }),
    ]);

    const kinds = screen.getAllByTestId("advisory-index-kind");
    expect(
      kinds.map((chip) => [chip.textContent, chip.getAttribute("data-tone")]),
    ).toEqual([
      ["Plan", "amber"],
      ["Out of scope", "neutral"],
    ]);
    for (const row of entryRows()) {
      expect(row.querySelectorAll('[data-tone="red"]')).toHaveLength(0);
    }
  });

  it("names each entry's originating context and round", () => {
    renderPanel([
      entry({
        contextId: "ctx-ui",
        identity: { roundSeq: 4, assignmentId: "design", ordinal: 2 },
      }),
    ]);

    const origin = within(entryRows()[0]!).getByTestId("advisory-index-origin");
    expect(origin).toHaveTextContent("Execution UI");
    expect(origin).toHaveTextContent("Round 4");
    expect(origin).toHaveTextContent("design");
  });

  it("falls back to the context id when the definition no longer names it", () => {
    renderPanel([entry({ contextId: "ctx-retired" })]);

    expect(
      within(entryRows()[0]!).getByTestId("advisory-index-origin"),
    ).toHaveTextContent("ctx-retired");
  });

  it("links each entry back to its originating context and round", () => {
    const { onOpenOrigin } = renderPanel([
      entry({
        contextId: "ctx-ui",
        identity: { roundSeq: 4, assignmentId: "design", ordinal: 1 },
      }),
      entry({
        contextId: "ctx-ui",
        identity: { roundSeq: 1, assignmentId: "design", ordinal: 2 },
        title: "The empty state is unreachable",
      }),
    ]);

    // The round travels with the link: a context has one history and many
    // rounds in it, so a link naming only the context would land on whichever
    // round the context happens to be on now.
    fireEvent.click(
      within(entryRows()[1]!).getByTestId("advisory-index-origin"),
    );

    expect(onOpenOrigin).toHaveBeenCalledWith({
      contextId: "ctx-ui",
      advisory: { roundSeq: 1, assignmentId: "design", ordinal: 2 },
    });
  });

  it("renders nothing at all when the run has raised no long-lived advisory", () => {
    render(<AdvisoryIndexPanel index={[]} contextTitles={contextTitles} />);

    expect(screen.queryByTestId("advisory-index")).toBeNull();
  });

  it("renders the origin as static text when the host cannot navigate", () => {
    render(
      <AdvisoryIndexPanel index={[entry()]} contextTitles={contextTitles} />,
    );

    const origin = screen.getByTestId("advisory-index-origin");
    expect(origin.tagName).not.toBe("BUTTON");
    expect(origin).toHaveTextContent("Round 1");
  });
});
