import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ContextHaltCard from "./ContextHaltCard";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import "./workflow-graph.css";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 520,
        padding: 16,
        background: "var(--bg-void)",
        color: "var(--text-primary)",
      }}
    >
      {children}
    </div>
  );
}

const meta = {
  title: "WorkflowGraph/ContextHaltCard",
  component: ContextHaltCard,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <Frame>
        <Story />
      </Frame>
    ),
  ],
} satisfies Meta<typeof ContextHaltCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const circuitBreaker: GraphWorkflowHaltReason = {
  type: "circuit_breaker",
  contextId: "context-implement",
  condition: "retry_exhaustion",
  failureCount: 3,
  summary:
    "Validator rejected the implementation three times in a row with the same kind of failure.",
};

const maxIterations: GraphWorkflowHaltReason = {
  type: "max_iterations",
  contextId: "context-plan",
  iterationCount: 5,
  summary: null,
};

const recoveryError: GraphWorkflowHaltReason = {
  type: "recovery_error",
  message: "Could not restore workflow state from disk: ENOENT",
};

const mergeFailure: GraphWorkflowHaltReason = {
  type: "merge_failure",
  contextId: "context-implement",
  message: "Merge conflict in 3 files",
  conflictFiles: [
    "src/lib/workflows/graph-workflow/runtime.ts",
    "src/types/index.ts",
    "src/app/api/projects/route.ts",
  ],
};

const mergePrecondition: GraphWorkflowHaltReason = {
  type: "merge_precondition_failed",
  contextId: "context-implement",
  targetBranch: "main",
  totalDirtyCount: 2,
  dirtyPaths: [
    { path: "src/index.ts", statusCode: " M", tracked: true },
    { path: ".env.local", statusCode: "??", tracked: false },
  ],
  message: "Working tree contains uncommitted changes",
};

const validatorInfra: GraphWorkflowHaltReason = {
  type: "validator_infra_error",
  contextId: "context-implement",
  engine: "claude",
  infraReason: "unparseable",
  message: "Validator returned non-JSON response",
  summary: null,
  assignmentId: "security-reviewer",
  attempts: 3,
  roundSeq: 4,
};

const longJoinFailure: GraphWorkflowHaltReason = {
  type: "join_failure",
  joinId: "join-final",
  joinKind: "final_publish",
  contextId: null,
  sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
  targetLaneId: "__session__",
  message:
    "Pre-merge validation failed\n$ bun scripts/generate-build-info.ts\n$ bun scripts/seam-adoption.ts --check\n$ bun run build:info && NODE_ENV=production next build && bun run build:cli",
  conflictFiles: Array.from(
    { length: 40 },
    (_, i) => `src/lib/specs/generated-file-${i}.ts`,
  ),
};

// A sign-off wait, not a failure: amber attention chrome with the
// ?el=delivery merge-gate link (F18/F19).
const deliveryApprovalRequired: GraphWorkflowHaltReason = {
  type: "delivery_gate_failed",
  unmet: [
    {
      criterionId: "execution-12:gate:1",
      criterionHandle: "native-sdd",
      outcome: "delivery_gate_failed",
      reason: "The delivery gate requires a human delivery approval.",
    },
  ],
  instruction:
    "Approve delivery in Spec Studio: open the spec's Controls view → Merge gate → Approve delivery for merge, then resume the merge.",
  refusalCode: "approval_required",
  spec: {
    specSlug: "native-sdd",
    specName: "Native SDD",
    projectName: "command-center",
  },
};

const deliveryUnmetCriteria: GraphWorkflowHaltReason = {
  type: "delivery_gate_failed",
  unmet: [
    {
      criterionId: "criterion-1",
      criterionHandle: "R1.1",
      outcome: "proof_required",
      reason: "No valid proof verdict exists for the pinned criterion.",
    },
    {
      criterionId: "criterion-2",
      criterionHandle: "R1.2",
      outcome: "missing_disposition",
      reason: "The pinned criterion has no execution disposition.",
    },
  ],
  instruction:
    "Repair or replace the graph execution until each required authored claimant has valid proof, resolve any remaining waiver requirements, then retry delivery.",
  spec: {
    specSlug: "native-sdd",
    specName: "Native SDD",
    projectName: "command-center",
  },
};

const outputSchemaRejection: GraphWorkflowHaltReason = {
  type: "circuit_breaker",
  contextId: "context-implement",
  condition: "output_schema_validation",
  failureCount: 3,
  summary: null,
};

export const CircuitBreaker: Story = {
  args: { primary: circuitBreaker },
};

/**
 * The one halt with a repair the card can point at (E2): it names the keyword
 * and the context that declared it, offers *Edit schema* as the way out, and
 * shows Resume as blocked until the contract is accepted.
 */
export const OutputSchemaRejected: Story = {
  args: {
    primary: outputSchemaRejection,
    outputSchemaEvidence: {
      "context-implement": {
        contextId: "context-implement",
        // Shaped as `toOutputSchemaIssues` emits: title EQUAL to path, with the
        // engine's words in the description.
        issues: [
          {
            path: "$.auditTable",
            title: "$.auditTable",
            description: "must be string",
          },
        ],
        rejectedOutput: '{"auditTable":[]}',
        // `format` is outside the enforceable subset, so the card names it as
        // the keyword no payload could ever satisfy.
        declaredSchema: {
          type: "object",
          additionalProperties: false,
          required: ["auditTable"],
          properties: { auditTable: { type: "string", format: "email" } },
        },
        schemaEditedSinceRejection: false,
        contractUnchangedSinceRejection: true,
        failureCount: 3,
        breakerThreshold: 3,
        iteration: 3,
        maxIterations: 4,
        gateRepairAttempts: 1,
        gateRepairBudget: 2,
      },
    },
    onEditSchema: () => {},
  },
};

/** Without a host that can navigate to the contract, the card offers the
 *  blocked Resume alone rather than a dead Edit schema button. */
export const OutputSchemaRejectedWithoutNavigation: Story = {
  args: {
    primary: outputSchemaRejection,
    outputSchemaEvidence: {
      "context-implement": {
        contextId: "context-implement",
        issues: [{ path: "$.auditTable", title: "$.auditTable" }],
        rejectedOutput: null,
        declaredSchema: null,
        schemaEditedSinceRejection: false,
        contractUnchangedSinceRejection: true,
        failureCount: 3,
        breakerThreshold: 3,
        iteration: null,
        maxIterations: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
      },
    },
  },
};

export const DeliveryApprovalRequired: Story = {
  args: { primary: deliveryApprovalRequired },
};

export const DeliveryUnmetCriteria: Story = {
  args: { primary: deliveryUnmetCriteria },
};

export const MaxIterations: Story = {
  args: { primary: maxIterations },
};

export const RecoveryError: Story = {
  args: { primary: recoveryError },
};

export const MergeFailure: Story = {
  args: { primary: mergeFailure },
};

export const MergePreconditionFailed: Story = {
  args: { primary: mergePrecondition },
};

export const ValidatorInfraError: Story = {
  args: { primary: validatorInfra },
};

/** A join failure with dozens of conflict files: the detail region scrolls
 *  inside its height bound instead of growing the card. */
export const LongJoinFailureBounded: Story = {
  args: { primary: longJoinFailure },
};

export const WithSecondaryHalts: Story = {
  args: {
    primary: circuitBreaker,
    secondary: [maxIterations, mergeFailure],
  },
};
