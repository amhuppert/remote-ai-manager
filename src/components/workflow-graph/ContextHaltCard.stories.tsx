import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ContextHaltCard from "./ContextHaltCard";
import type { GraphWorkflowHaltReason } from "@/lib/workflows/schemas";
import "./workflow-graph.css";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 520,
        padding: 16,
        background: "var(--bg-void)",
        color: "var(--text-strong)",
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
};

export const CircuitBreaker: Story = {
  args: { primary: circuitBreaker, variant: "card" },
};

export const MaxIterations: Story = {
  args: { primary: maxIterations, variant: "card" },
};

export const RecoveryError: Story = {
  args: { primary: recoveryError, variant: "card" },
};

export const MergeFailure: Story = {
  args: { primary: mergeFailure, variant: "card" },
};

export const MergePreconditionFailed: Story = {
  args: { primary: mergePrecondition, variant: "card" },
};

export const ValidatorInfraError: Story = {
  args: { primary: validatorInfra, variant: "card" },
};

export const BannerVariant: Story = {
  args: { primary: circuitBreaker, variant: "banner" },
};

export const WithSecondaryHalts: Story = {
  args: {
    primary: circuitBreaker,
    secondary: [maxIterations, mergeFailure],
    variant: "card",
  },
};
