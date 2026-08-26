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
    summary: fixture.summary,
    artifacts: fixture.artifacts,
    assumptions: fixture.assumptions,
    key_claims: fixture.key_claims,
  };
}

export const ClaudePrimaryFromFixture = {
  args: fromInitialDraftFixture(makeAgentOneInitialDraft(), "claude", true),
} satisfies Story;

export const WithModelSettings = {
  args: {
    ...fromInitialDraftFixture(makeAgentOneInitialDraft(), "claude", true),
    modelSettings: {
      modelId: "fable",
      parameters: { effort: "max" },
    },
  },
} satisfies Story;

export const CodexSecondaryFromFixture = {
  args: fromInitialDraftFixture(makeAgentTwoInitialDraft(), "codex", false),
} satisfies Story;

export const NoOptionalSectionsFromFixture = {
  args: fromInitialDraftFixture(
    makeAgentOneInitialDraft({
      artifacts: [],
      assumptions: [],
      key_claims: [],
    }),
    "claude",
    true,
  ),
} satisfies Story;
