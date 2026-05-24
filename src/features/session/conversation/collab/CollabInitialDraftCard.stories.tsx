import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  makeAgentOneInitialDraft,
  makeAgentTwoInitialDraft,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabInitialDraftCard, {
  type CollabInitialDraftCardProps,
} from "@/features/session/conversation/collab/CollabInitialDraftCard";

const meta = {
  title: "Collab/CollabInitialDraftCard",
  component: CollabInitialDraftCard,
  args: {
    onRefClick: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabInitialDraftCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromInitialDraftFixture(
  fixture: ReturnType<typeof makeAgentOneInitialDraft>,
  backend: CollaborationAgent,
  isPrimary: boolean,
): Omit<CollabInitialDraftCardProps, "onRefClick"> {
  return {
    agent: backend,
    isPrimary,
    narrative: fixture.narrative,
    supporting: fixture.supporting,
    assumptions: fixture.assumptions,
    keyClaims: fixture.keyClaims,
  };
}

export const ClaudePrimaryFromFixture = {
  args: fromInitialDraftFixture(makeAgentOneInitialDraft(), "claude", true),
} satisfies Story;

export const CodexSecondaryFromFixture = {
  args: fromInitialDraftFixture(makeAgentTwoInitialDraft(), "codex", false),
} satisfies Story;

export const NoOptionalSectionsFromFixture = {
  args: fromInitialDraftFixture(
    makeAgentOneInitialDraft({
      supporting: [],
      assumptions: [],
      keyClaims: [],
    }),
    "claude",
    true,
  ),
} satisfies Story;
