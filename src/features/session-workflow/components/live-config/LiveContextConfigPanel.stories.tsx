import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { fn } from "storybook/test";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import LiveContextConfigPanel from "./LiveContextConfigPanel";

/**
 * The Config tab of a LIVE execution, in each of the four §8.1 affordance modes
 * over real execution data.
 *
 * The fixture is a started context — three iterations in, a provisioned lane
 * worktree, a blocking validator seat — because that is the row of the matrix
 * where the mode actually depends on the EXECUTION's state rather than the
 * context's: the same context reads editable on a paused run and pause-to-edit
 * on a running one. Everything else on screen (provenance chips, runtime rows,
 * derived schema counts) is computed from this payload, not authored here.
 */

const CONTEXT_ID = "context-impl";
const PROJECT = "checkout";

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    confidence: { type: "number" },
    blockers: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "confidence"],
};

function context(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    id: CONTEXT_ID,
    title: "Implement checkout",
    description: "Wire the checkout flow end to end behind the existing gate.",
    acceptanceCriteria: "Checkout completes and the receipt persists.",
    placement: { lane: "delivery", mode: "full" },
    outputSchema: SCHEMA,
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    },
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          profileSnapshot: makeProfileSnapshot(),
          strategy: "conversation",
          authority: "blocking",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        },
      ],
    },
    scriptValidator: { commands: ["typecheck", "test"] },
    scriptValidatorSource: "workflow",
    humanApprovalGate: { enabled: true },
    askUserQuestions: { enabled: true },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20 },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    collaboration: {
      enabled: { value: true, source: "per-node" },
      secondAgent: {
        value: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "high", fast: "false" },
          },
        },
        source: "per-node",
      },
      negotiationRounds: { value: 5, source: "workflow" },
      autonomousResolutionThreshold: { value: "major", source: "global" },
    },
    ...overrides,
  };
}

/** Ran already: iterations banked and a lane worktree provisioned. */
function startedState(
  overrides: Partial<GraphWorkflowExecutionContextState> = {},
): GraphWorkflowExecutionContextState {
  return {
    skipReason: null,
    landingIntent: null,
    contextId: CONTEXT_ID,
    status: "running",
    totalTaskCount: 4,
    completedTaskCount: 1,
    iterationCount: 3,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
    worktreePath: "/Users/dev/wt/delivery",
    branchName: "csm/delivery-checkout",
    isolation: "worktree",
    batchId: "batch-7",
    laneId: "delivery",
    joinId: "join-2",
    mergeStatus: "pending",
    cleanupStatus: "pending",
    lastMergeError: null,
    pendingApproval: null,
    pendingUserInputs: {},
    ...overrides,
  };
}

function execution(
  overrides: Partial<GraphWorkflowExecution> = {},
  resolved: GraphWorkflowResolvedContext = context(),
  state: GraphWorkflowExecutionContextState = startedState(),
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "paused",
    workingDefinition: {
      schemaVersion: 1,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
      executionContexts: [resolved],
      tasks: [],
      edges: [],
    },
    activeContextIds: [],
    contextStates: { [CONTEXT_ID]: state },
    taskStates: {},
    ...overrides,
  });
}

function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[820px] w-[420px] border border-solid border-border-dim">
      {children}
    </div>
  );
}

function Canvas({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type PanelProps = React.ComponentProps<typeof LiveContextConfigPanel>;

function Panel(overrides: Partial<PanelProps>) {
  return (
    <Canvas>
      <Rail>
        <LiveContextConfigPanel
          execution={execution()}
          contextId={CONTEXT_ID}
          libraryProjectName={PROJECT}
          onSaveContextConfig={fn()}
          onPauseExecution={fn()}
          onResumeExecution={fn()}
          onResetContext={fn()}
          {...overrides}
        />
      </Rail>
    </Canvas>
  );
}

const meta = {
  title: "SessionWorkflow/LiveContextConfigPanel",
  component: LiveContextConfigPanel,
  parameters: { layout: "centered" },
  args: { execution: execution(), contextId: CONTEXT_ID },
} satisfies Meta<typeof LiveContextConfigPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **Editable** — a started context on a paused (quiescent) run. The full editor
 * with the sticky save bar; every cascade block resolves from the snapshot the
 * run actually holds, and the inherited chips name the tier the seed recorded.
 */
export const Editable: Story = {
  render: () => <Panel />,
};

/**
 * **Pause to edit** — the same context while the run is going. The amber banner
 * carries the one affordance with a way out; every control below is disabled
 * until the execution comes back quiescent.
 */
export const PauseToEdit: Story = {
  render: () => (
    <Panel
      execution={execution({
        status: "running",
        activeContextIds: [CONTEXT_ID],
      })}
    />
  ),
};

/** The pause is in flight: the action reports itself and stops accepting. */
export const Pausing: Story = {
  render: () => (
    <Panel
      execution={execution({
        status: "running",
        activeContextIds: [CONTEXT_ID],
      })}
      isPausing
    />
  ),
};

/**
 * **Frozen** — the context itself completed. Everything is locked, and the lock
 * banner says the configuration is settled rather than that the run is over.
 */
export const Frozen: Story = {
  render: () => (
    <Panel
      execution={execution(
        { status: "paused" },
        context(),
        startedState({ status: "completed", completedTaskCount: 4 }),
      )}
    />
  ),
};

/**
 * **Read-only** — the execution is over. The banner carries the classifier's
 * own reason verbatim, and no save bar is offered at all.
 */
export const ReadOnlyCompleted: Story = {
  render: () => <Panel execution={execution({ status: "completed" })} />,
};

/** The other read-only tenure an author actually meets: a parked plan. */
export const ReadOnlyAwaitingApproval: Story = {
  render: () => (
    <Panel
      execution={execution({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-20T10:00:00.000Z",
          approvedAt: null,
        },
      })}
    />
  ),
};

/**
 * The contract is frozen INDEPENDENTLY of the mode: output was captured against
 * this schema, so the declaration is settled even though the paused context is
 * otherwise fully editable. Opens on the schema screen to show the lock.
 */
export const FrozenSchemaWhileEditable: Story = {
  render: () => (
    <Panel
      execution={execution({
        status: "paused",
        contextOutputs: {
          [CONTEXT_ID]: {
            value: { verdict: "pass", confidence: 0.9, blockers: [] },
            capturedAt: "2026-08-20T12:00:00.000Z",
            iteration: 2,
            parse: { source: "native" },
          },
        },
      })}
      focusScreen={["brief", "schema"]}
    />
  ),
};

/** A save the server refused as a revision conflict: the edits are kept. */
export const RevisionConflict: Story = {
  render: () => <Panel editConflict focusScreen={["policy"]} />,
};

/** A non-conflict refusal, in the server's own words, at the edit site. */
export const SaveError: Story = {
  render: () => (
    <Panel
      editError="Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry."
      focusScreen={["policy"]}
    />
  ),
};

/** The save landed; the pause-to-edit flow can now be finished. */
export const SavedOfferingResume: Story = {
  render: () => <Panel saveSucceeded />,
};

/** The resume is in flight. */
export const Resuming: Story = {
  render: () => <Panel saveSucceeded isResuming />,
};

/** Started assignments remain fixed on an otherwise editable paused execution. */
export const StartedImplementer: Story = {
  render: () => (
    <Panel
      execution={execution({
        laneStates: {
          [CONTEXT_ID]: {
            implementer: {
              lane: "implementer",
              contextId: CONTEXT_ID,
              backend: "claude",
              refKind: "conversation",
              workflowConversationId: "conv_implementer",
              metrics: {},
              lastUsedAt: "2026-09-18T10:00:00.000Z",
            },
          },
        },
      })}
      focusScreen={["agents", "implementer"]}
    />
  ),
};
