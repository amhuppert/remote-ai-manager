import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { UserInputStanding } from "@/hooks/use-user-input-gate";
import ParkedQuestionPanel from "./ParkedQuestionPanel";

const toggleQuestion: UserInputStanding["questions"][number] = {
  id: "q1",
  question: "Should the toggle default to on?",
  header: "Toggle",
  multiSelect: false,
  required: true,
  allowNote: true,
  options: [
    {
      label: "on",
      recommended: true,
      description: "Matches the rest of the settings surface.",
    },
    { label: "off", recommended: false, description: "Opt-in only." },
  ],
};

const meta = {
  title: "SessionWorkflow/ParkedQuestionPanel",
  component: ParkedQuestionPanel,
  args: {
    projectName: "command-center",
    sessionName: "settings-surface",
    standing: {
      contextId: "context-settings",
      laneKey: "implementer",
      conversationId: "conv-implementer",
      questionBatchId: "batch-1",
      questions: [toggleQuestion],
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 420,
          padding: 16,
          background: "var(--bg-void)",
          color: "var(--text-primary)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ParkedQuestionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Where a *parked question* gate row lands: the same framing, now answerable. */
export const ImplementerAsking = {} satisfies Story;

/** A cohort parks per seat, so the card names the seat rather than the lane. */
export const ValidatorSeatAsking = {
  args: {
    standing: {
      contextId: "context-settings",
      laneKey: "context_validator:security-reviewer",
      conversationId: "conv-security",
      questionBatchId: "batch-2",
      questions: [
        {
          ...toggleQuestion,
          id: "q2",
          question: "Is an audit entry required for the toggle?",
          header: "Audit",
        },
      ],
    },
  },
} satisfies Story;

export const SeveralQuestions = {
  args: {
    standing: {
      contextId: "context-settings",
      laneKey: "implementer",
      conversationId: "conv-implementer",
      questionBatchId: "batch-3",
      questions: [
        toggleQuestion,
        {
          id: "q3",
          question: "Which rollout should ship first?",
          header: "Rollout",
          multiSelect: false,
          required: true,
          allowNote: true,
          options: [
            { label: "canary", recommended: true, description: "" },
            { label: "full", recommended: false, description: "" },
          ],
        },
      ],
    },
  },
} satisfies Story;
