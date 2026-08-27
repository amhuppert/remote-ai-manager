// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotepadSummaryResolution } from "@/lib/notepads/queries";
import type { NotepadRefAttrs } from "@/lib/notepads/schemas";
import { createNotepadRefChips } from "./NotepadRefChips";

afterEach(cleanup);

/** The attributes captured when the reference was inserted, before any rename. */
const CAPTURED: NotepadRefAttrs = {
  "notepad-id": "np-7f3a",
  name: "Release checklist",
  scope: "project",
  "project-name": "command-center",
  "read-command": "cctl notepad get 'np-7f3a'",
};

function chipsResolving(
  resolution: NotepadSummaryResolution | undefined,
  flags: { isLoading?: boolean; isError?: boolean } = {},
) {
  const useNotepadSummary = vi.fn(() => ({
    data: resolution,
    isLoading: flags.isLoading ?? false,
    isError: flags.isError ?? false,
  }));
  return { ...createNotepadRefChips({ useNotepadSummary }), useNotepadSummary };
}

function found(name: string): NotepadSummaryResolution {
  return {
    state: "found",
    summary: {
      id: "np-7f3a",
      name,
      scope: "project",
      revision: 4,
      writeMode: "full-edit",
      archived: false,
    },
  };
}

describe("notepad reference chips", () => {
  it("renders the current name after a rename, not the captured snapshot", () => {
    const { NotepadRefTranscriptChip } = chipsResolving(found("Launch checks"));

    render(<NotepadRefTranscriptChip attrs={CAPTURED} />);

    expect(screen.getByText("Launch checks")).toBeVisible();
    expect(screen.queryByText("Release checklist")).toBeNull();
  });

  it("resolves the label by immutable id, not by the captured name", () => {
    const { NotepadRefTranscriptChip, useNotepadSummary } = chipsResolving(
      found("Launch checks"),
    );

    render(<NotepadRefTranscriptChip attrs={CAPTURED} />);

    expect(useNotepadSummary).toHaveBeenCalledWith("np-7f3a");
  });

  it("renders a missing state rather than erroring when the notepad is gone", () => {
    const { NotepadRefTranscriptChip } = chipsResolving({ state: "missing" });

    render(<NotepadRefTranscriptChip attrs={CAPTURED} />);

    const chip = screen.getByTestId("notepad-ref-chip");
    expect(chip).toHaveAttribute("data-notepad-missing", "true");
    // The name it was captured under is still shown, so the reader can tell
    // WHICH notepad went missing.
    expect(chip).toHaveTextContent("Release checklist");
    expect(chip).toHaveTextContent(/missing/i);
  });

  it("falls back to the captured name while the live name is still loading", () => {
    const { NotepadRefTranscriptChip } = chipsResolving(undefined, {
      isLoading: true,
    });

    render(<NotepadRefTranscriptChip attrs={CAPTURED} />);

    expect(screen.getByText("Release checklist")).toBeVisible();
    expect(screen.getByTestId("notepad-ref-chip")).not.toHaveAttribute(
      "data-notepad-missing",
    );
  });

  it("keeps the captured name when the lookup fails for a reason other than deletion", () => {
    const { NotepadRefTranscriptChip } = chipsResolving(undefined, {
      isError: true,
    });

    render(<NotepadRefTranscriptChip attrs={CAPTURED} />);

    expect(screen.getByText("Release checklist")).toBeVisible();
    expect(screen.getByTestId("notepad-ref-chip")).not.toHaveAttribute(
      "data-notepad-missing",
    );
  });

  it("resolves the same live name in the editor chip", () => {
    const { NotepadRefEditorChipBody } = chipsResolving(found("Launch checks"));

    render(
      <NotepadRefEditorChipBody
        notepadId="np-7f3a"
        name="Release checklist"
        selected={false}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText("Launch checks")).toBeVisible();
  });

  it("shows the missing state in the editor chip too", () => {
    const { NotepadRefEditorChipBody } = chipsResolving({ state: "missing" });

    render(
      <NotepadRefEditorChipBody
        notepadId="np-7f3a"
        name="Release checklist"
        selected={false}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId("notepad-ref-chip")).toHaveAttribute(
      "data-notepad-missing",
      "true",
    );
  });

  it("removes the reference from the prompt when the editor chip is dismissed", () => {
    const { NotepadRefEditorChipBody } = chipsResolving(found("Launch checks"));
    const onRemove = vi.fn();

    render(
      <NotepadRefEditorChipBody
        notepadId="np-7f3a"
        name="Release checklist"
        selected={false}
        onRemove={onRemove}
      />,
    );
    screen.getByRole("button", { name: /remove notepad reference/i }).click();

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
