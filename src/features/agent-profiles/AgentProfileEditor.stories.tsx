"use client";

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import {
  findBuiltinAgentProfile,
  STANDARD_AGENT_PROFILE_ID,
} from "@/lib/agent-profiles/builtins";

import AgentProfileEditor, {
  type AgentProfileEditorProps,
} from "./AgentProfileEditor";
import type { AgentProfileDraft } from "./agent-profile-draft";

const editableDraft = {
  name: "House Style",
  description: "Writes the way this repository writes.",
  instructions:
    "Prefer small, focused changes. Reuse established boundaries and verify behavior before reporting completion.",
  recommendedFor: ["conversation", "workflow_implementer"],
  tagsText: "style, implementation",
} satisfies AgentProfileDraft;

/**
 * The shipped default, read from the built-in record so the read-only story
 * shows what the library actually holds — including its empty instructions,
 * which is how a no-op profile reads in the editor.
 */
const standardAgent = findBuiltinAgentProfile(STANDARD_AGENT_PROFILE_ID);
if (standardAgent === undefined) {
  throw new Error("the standard-agent built-in is missing");
}

const readOnlyDraft = {
  name: standardAgent.name,
  description: standardAgent.description,
  instructions: standardAgent.instructions,
  recommendedFor: [...standardAgent.recommendedFor],
  tagsText: standardAgent.tags.join(", "),
} satisfies AgentProfileDraft;

function EditorFrame(props: AgentProfileEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState(props.draft);

  return (
    <div className="min-h-screen bg-bg-void p-lg">
      <section className="mx-auto w-full max-w-[960px] rounded-md border border-solid border-border-default bg-bg-surface p-md">
        <AgentProfileEditor
          {...props}
          draft={draft}
          onDraftChange={(nextDraft) => {
            setDraft(nextDraft);
            props.onDraftChange(nextDraft);
          }}
        />
      </section>
    </div>
  );
}

const meta = {
  title: "Agents/AgentProfileEditor",
  component: AgentProfileEditor,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
  args: {
    draft: editableDraft,
    onDraftChange: fn(),
    ref_: { tier: "project", id: "house-style" },
    targetTier: "project",
    revision: 5,
    readOnly: false,
    saving: false,
    onSave: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    confirmingDelete: false,
    onConfirmingDeleteChange: fn(),
    deletionPreview: { isPending: false, error: null, report: null },
    serverError: null,
  },
  render: (args) => <EditorFrame {...args} />,
} satisfies Meta<typeof AgentProfileEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ReadOnly: Story = {
  args: {
    draft: readOnlyDraft,
    ref_: { tier: "builtin", id: "standard-agent" },
    targetTier: "project",
    revision: 1,
    readOnly: true,
  },
};
