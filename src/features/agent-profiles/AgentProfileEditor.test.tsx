// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import AgentProfileEditor, {
  type AgentProfileEditorProps,
} from "./AgentProfileEditor";
import { emptyAgentProfileDraft } from "./agent-profile-draft";

const draft = {
  ...emptyAgentProfileDraft(),
  name: "House Style",
  description: "Writes the way this repo writes.",
  instructions: "Prefer small, focused changes.",
};

function renderEditor(overrides: Partial<AgentProfileEditorProps> = {}): void {
  render(
    <AgentProfileEditor
      draft={draft}
      onDraftChange={vi.fn()}
      ref_={null}
      targetTier="project"
      revision={null}
      readOnly={false}
      saving={false}
      onSave={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      confirmingDelete={false}
      onConfirmingDeleteChange={vi.fn()}
      deletionPreview={{ isPending: false, error: null, report: null }}
      serverError={null}
      {...overrides}
    />,
  );
}

it("uses the full-width design-system form treatment for profile instructions", () => {
  renderEditor();

  expect(Array.from(screen.getByLabelText("Instructions").classList)).toEqual(
    expect.arrayContaining([
      "box-border",
      "w-full",
      "border-border-default",
      "bg-bg-base",
      "font-mono",
      "text-text-primary",
    ]),
  );
});

it("saves valid profile instructions through the multiline primary chord", () => {
  const onSave = vi.fn();
  renderEditor({ onSave });

  fireEvent.keyDown(screen.getByLabelText("Instructions"), {
    key: "Enter",
    ctrlKey: true,
  });

  expect(onSave).toHaveBeenCalledWith({
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    recommendedFor: [],
    tags: [],
  });
});
