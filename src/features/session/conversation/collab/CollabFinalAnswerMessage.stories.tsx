import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { makeFinalAnswer } from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabFinalAnswerMessage, {
  type CollabFinalAnswerMessageProps,
} from "@/features/session/conversation/collab/CollabFinalAnswerMessage";

const meta = {
  title: "Collab/CollabFinalAnswerMessage",
  component: CollabFinalAnswerMessage,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabFinalAnswerMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromFinalAnswerFixture(
  fixture: ReturnType<typeof makeFinalAnswer>,
  backend: CollaborationAgent,
): CollabFinalAnswerMessageProps {
  return {
    agent: backend,
    summary: fixture.summary,
    artifacts: fixture.artifacts,
    answer_artifact_id: fixture.answer_artifact_id,
  };
}

export const ClaudeFromFixture = {
  args: fromFinalAnswerFixture(makeFinalAnswer(), "claude"),
} satisfies Story;

export const WithModelSettings = {
  args: {
    ...fromFinalAnswerFixture(makeFinalAnswer(), "claude"),
    modelSettings: {
      modelId: "fable",
      parameters: { effort: "max" },
    },
  },
} satisfies Story;

export const CodexFromFixture = {
  args: fromFinalAnswerFixture(
    makeFinalAnswer({
      summary:
        "Ship as v1 with additive fields. Defer the v2 contract change to a separate proposal.",
    }),
    "codex",
  ),
} satisfies Story;
