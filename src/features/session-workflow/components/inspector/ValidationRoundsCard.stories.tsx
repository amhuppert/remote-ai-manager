import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { GraphWorkflowValidationResultEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowValidationRound } from "@/lib/workflow-graph/schemas";
import ValidationRoundsCard from "./ValidationRoundsCard";
import type { Timestamped } from "./history-entries";
import type { ValidationRoundRow } from "./validation-rounds-model";

/**
 * History tab → Validation rounds (§11), in the states a reader meets: a round
 * still in flight with its roster frozen and its seats running, a concluded
 * rejection whose artifacts, spend and references are on the row.
 *
 * Rows are authored rather than derived — `validation-rounds-model.test.ts`
 * owns the proof that an execution produces these shapes.
 */

/** Raised by round 1's security seat — the advisory an origin link aims at. */
const ROUND_ONE_ADVISORY = {
  kind: "plan" as const,
  title: "The backfill is not planned anywhere",
  description: "Nothing writes the historic rows.",
  identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
  deliveredAt: null,
  disposition: null,
};

const ROSTER: GraphWorkflowValidationRound["roster"] = [
  {
    assignmentId: "security",
    profileRef: { tier: "project", id: "security-reviewer" },
    revision: 1,
    resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
    strategy: "conversation",
  },
  {
    assignmentId: "performance",
    profileRef: { tier: "project", id: "performance-reviewer" },
    revision: 2,
    resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
    strategy: "conversation",
  },
];

const CANDIDATE: GraphWorkflowValidationRound["candidate"] = {
  headSha: "9f3c1ab",
  candidateTreeHash: "tree-2",
  taskStateHash: "tasks-2",
  identityScope: "wholeTree",
};

const OPEN_ROUND: GraphWorkflowValidationRound = {
  seq: 2,
  candidate: CANDIDATE,
  roster: ROSTER,
  specialists: {
    security: {
      state: "running",
      attempts: 1,
      summary: null,
      issues: [],
      advisories: [],
      questionToken: null,
      sessionRef: {
        backend: "claude",
        ref: "conv_val_security_2",
        lane: "context_validator",
        refKind: "conversation",
        workflowConversationId: "conv_val_security_2",
      },
      reviewArtifact: null,
      lastInfraFailure: null,
    },
    performance: {
      state: "pending",
      attempts: 0,
      summary: null,
      issues: [],
      advisories: [],
      questionToken: null,
      sessionRef: null,
      reviewArtifact: null,
      lastInfraFailure: null,
    },
  },
  phase: "specialists",
  outcome: null,
  startedAt: "2026-03-27T11:05:00.000Z",
};

const REJECTION: Timestamped<GraphWorkflowValidationResultEvent> = {
  occurredAt: "2026-03-27T10:42:00.000Z",
  logIndex: 12,
  type: "graph-workflow-validation-result",
  projectName: "command-center",
  sessionName: "session-1",
  executionId: "execution-1",
  contextId: "context-implement",
  validatorType: "context",
  kind: "context_validation",
  pass: false,
  summary: "the timeout path writes no audit record",
  reopenTaskIds: ["task-implement-1"],
  issues: [],
  rejectedOutput: null,
  gateRepairAttempts: null,
  gateRepairBudget: null,
  roundSeq: 1,
  specialists: [
    {
      assignmentId: "security",
      profile: { tier: "project", id: "security-reviewer", revision: 1 },
      resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
      pass: false,
      summary: "risk rules bypass the audit log on the timeout path",
      issues: [
        {
          taskId: "task-implement-1",
          title: "Timeout branch skips the audit write",
          description:
            "The success branch writes an audit record; the timeout branch returns before it.",
        },
      ],
      advisories: [ROUND_ONE_ADVISORY],
      sessionRef: {
        backend: "claude",
        ref: "conv_val_security_1",
        lane: "context_validator",
        refKind: "conversation",
        workflowConversationId: "conv_val_security_1",
      },
      reviewArtifact: {
        backend: "claude",
        kind: "response",
        ref: "artifact/security-round-1",
        response: "risk rules bypass the audit log on the timeout path",
        usage: {
          inputTokens: 18400,
          cachedInputTokens: 12000,
          outputTokens: 2100,
          costUsd: 0.42,
        },
      },
      usage: {
        inputTokens: 18400,
        cachedInputTokens: 12000,
        outputTokens: 2100,
        costUsd: 0.42,
        apiTurns: 3,
      },
    },
  ],
};

const IN_FLIGHT_ROW: ValidationRoundRow = {
  seq: 2,
  iteration: 2,
  status: "in_flight",
  statusLabel: "in flight",
  roster: ["security", "performance"],
  references: [],
  usage: null,
  live: OPEN_ROUND,
  record: null,
};

const REJECTED_ROW: ValidationRoundRow = {
  seq: 1,
  iteration: 1,
  status: "rejected",
  statusLabel: "rejected",
  roster: ["security", "performance"],
  references: ["artifact/security-round-1"],
  usage: {
    inputTokens: 18400,
    cachedInputTokens: 12000,
    outputTokens: 2100,
    costUsd: 0.42,
    apiTurns: 3,
  },
  live: null,
  record: REJECTION,
};

const sharedArgs = {
  contextId: "context-implement",
  cohortAssignments: [
    { id: "security", authority: "blocking" as const },
    { id: "performance", authority: "advisory" as const },
  ],
  incidents: [],
  advisoryResponse: null,
  reusedRecords: new Set<Timestamped<GraphWorkflowValidationResultEvent>>(),
  unroundedRecords: [],
  focusedAdvisory: null,
  focusAnchorId: "story-round-anchor",
  onViewConversation: fn(),
};

function StoryWrapper(
  props: React.ComponentPropsWithoutRef<typeof ValidationRoundsCard>,
) {
  return (
    <div className="w-[420px] bg-bg-void p-lg">
      <ValidationRoundsCard {...props} />
    </div>
  );
}

const meta = {
  title: "Workflow/Inspector/ValidationRoundsCard",
  component: StoryWrapper,
  parameters: { layout: "centered", backgrounds: { default: "dark" } },
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Round 2 is still being judged; round 1's rejection stands above its artifacts. */
export const BothStates: Story = {
  args: { ...sharedArgs, rows: [IN_FLIGHT_ROW, REJECTED_ROW] },
};

/** A round in flight alone: frozen roster, seats running, nothing to show yet. */
export const InFlight: Story = {
  args: { ...sharedArgs, rows: [IN_FLIGHT_ROW] },
};

/**
 * A concluded rejection, opened by the origin link of the advisory it raised —
 * the round is found by holding that advisory, not by wearing its number. Its
 * artifacts, spend and references are what the round footer carries.
 */
export const RejectedWithArtifacts: Story = {
  args: {
    ...sharedArgs,
    rows: [REJECTED_ROW],
    focusedAdvisory: ROUND_ONE_ADVISORY.identity,
  },
};

export const NeverValidated: Story = {
  args: { ...sharedArgs, rows: [] },
};
