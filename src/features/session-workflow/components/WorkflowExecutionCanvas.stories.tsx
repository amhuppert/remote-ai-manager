import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, waitFor, within, userEvent } from "storybook/test";
import { z } from "zod";
// The canvas takes React Flow's base stylesheet from its host panel, so a story
// rendering it directly has to supply it — without the vendor rules a node is a
// full-width block, AutoLayout measures that width, and the generated geometry
// is metres wide. Every other React Flow story here does the same.
import "@xyflow/react/dist/base.css";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { SESSION_LANE_ID } from "@/lib/workflow-graph/lane-identity";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import type { ResolvedWorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";

/**
 * A context as the WORKING definition holds it — resolved, so its config blocks
 * are `{ value, source }` pairs rather than the authored plain values. A
 * launched execution only ever schedules this shape.
 */
type ResolvedContext =
  ResolvedWorkflowSemanticDefinition["executionContexts"][number];

/**
 * The execution canvas across the DELIVERY window — the stretch after the last
 * implementer turn, where work is committed to lane worktrees and joins carry
 * it into the session. Every story here is a snapshot of that window, because
 * it is the phase the canvas used to render as a uniform wall of green
 * "Completed" cards with no statement of where any of the work actually was.
 *
 * The builder's `RepresentativeLayout` covers geometry; these cover state.
 */

const NOW = "2026-08-24T14:00:00.000Z";
const SESSION_BRANCH = "cc/checkout-v2";

const firstContext = createResolvedWorkflowDefinition().executionContexts[0];
if (!firstContext) throw new Error("fixture has no execution context");
// Bound separately: the narrowing from the guard above does not reach inside
// `context()`, so spreading the unbound value would make every field optional.
const TEMPLATE: ResolvedContext = firstContext;

// Derived, not hand-written: a schema literal here would add old-way debt to
// the structured-output-schema-literals seam.
const reportSchema: Record<string, unknown> = {
  ...z.toJSONSchema(
    z.object({ summary: z.string(), risks: z.array(z.string()) }),
  ),
};
delete reportSchema.$schema;

function context(
  id: string,
  title: string,
  placement: ResolvedContext["placement"],
  overrides: Partial<ResolvedContext> = {},
): ResolvedContext {
  return {
    ...TEMPLATE,
    id,
    title,
    description: `${title}.`,
    acceptanceCriteria: `${title} is complete.`,
    placement,
    ...overrides,
  };
}

const CONTEXTS: ResolvedContext[] = [
  context("survey", "Survey code", { lane: "research", mode: "full" }),
  context("api-design", "Design API", { lane: "api", mode: "full" }),
  context("api-impl", "Implement API", { lane: "api", mode: "full" }),
  context("ui-impl", "Implement UI", { lane: "ui", mode: "full" }),
  // The reserved session lane admits read-only members only, and a read-only
  // context delivers exclusively through its output contract.
  context(
    "report",
    "Delivery report",
    { lane: "session", mode: "readOnly" },
    { outputSchema: reportSchema },
  ),
];

const EDGES = [
  { id: "e-survey-api", sourceContextId: "survey", targetContextId: "api-design" },
  {
    id: "e-design-impl",
    sourceContextId: "api-design",
    targetContextId: "api-impl",
  },
  { id: "e-survey-ui", sourceContextId: "survey", targetContextId: "ui-impl" },
  { id: "e-impl-report", sourceContextId: "api-impl", targetContextId: "report" },
  { id: "e-ui-report", sourceContextId: "ui-impl", targetContextId: "report" },
];

const DEFINITION: ResolvedWorkflowSemanticDefinition = {
  ...createResolvedWorkflowDefinition(),
  executionContexts: CONTEXTS,
  tasks: CONTEXTS.map((member) => ({
    id: `task-${member.id}`,
    contextId: member.id,
    order: 1,
    title: member.title,
    instructions: `Carry out: ${member.title.toLowerCase()}.`,
    source: "user" as const,
  })),
  edges: EDGES,
};

function contextState(
  contextId: string,
  overrides: Partial<GraphWorkflowExecutionContextState> = {},
): GraphWorkflowExecutionContextState {
  return {
    contextId,
    status: "completed",
    totalTaskCount: 1,
    completedTaskCount: 1,
    iterationCount: 1,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
    worktreePath: null,
    branchName: null,
    isolation: "worktree",
    batchId: null,
    laneId: null,
    joinId: null,
    mergeStatus: "merged-success",
    cleanupStatus: "not-applicable",
    lastMergeError: null,
    pendingApproval: null,
    pendingUserInputs: {},
    skipReason: null,
    landingIntent: null,
    ...overrides,
  };
}

function lane(
  laneId: string,
  overrides: Partial<GraphWorkflowExecutionLaneState> = {},
): GraphWorkflowExecutionLaneState {
  return {
    laneId,
    kind: "worktree",
    status: "active",
    worktreePath: `/repo/.worktrees/checkout-v2.${laneId}`,
    branchName: `${SESSION_BRANCH}-${laneId}`,
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function join(
  joinId: string,
  overrides: Partial<GraphWorkflowExecutionJoinState> = {},
): GraphWorkflowExecutionJoinState {
  return {
    joinId,
    kind: "context_merge",
    contextId: null,
    targetLaneId: SESSION_LANE_ID,
    sourceLaneIds: [],
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

const SESSION_LANE = lane(SESSION_LANE_ID, {
  kind: "session",
  branchName: SESSION_BRANCH,
  worktreePath: "/repo/.worktrees/checkout-v2",
  includedContextIds: ["report"],
});

/**
 * The shared delivery-window snapshot. Callers vary only the publish join, so
 * every story below describes the same run at a different moment of its merge
 * rather than a differently-shaped workflow.
 */
function deliveryExecution(
  publishJoin: GraphWorkflowExecutionJoinState,
): GraphWorkflowExecution {
  // Lane status is DERIVED from the join ledger, exactly as the transition
  // owner derives it — a fixture that hand-wrote `merged` could describe a lane
  // the engine would never produce, which is how the canvas came to render a
  // state nobody had actually seen.
  const merged = new Set(publishJoin.mergedSourceLaneIds);
  const laneStatus = (laneId: string): GraphWorkflowExecutionLaneState["status"] =>
    merged.has(laneId) ? "merged" : "active";

  return createWorkflowExecution({
    id: "execution-delivery",
    status: "running",
    workingDefinition: DEFINITION,
    activeContextIds: [],
    contextStates: {
      survey: contextState("survey", { laneId: "research" }),
      "api-design": contextState("api-design", { laneId: "api" }),
      "api-impl": contextState("api-impl", { laneId: "api" }),
      "ui-impl": contextState("ui-impl", { laneId: "ui" }),
      // Read-only: writes nothing, so it owes no merge and carries no merge
      // status of its own.
      report: contextState("report", {
        laneId: SESSION_LANE_ID,
        mergeStatus: "not-applicable",
      }),
    },
    taskStates: Object.fromEntries(
      CONTEXTS.map((member) => [
        `task-${member.id}`,
        {
          taskId: `task-${member.id}`,
          contextId: member.id,
          order: 1,
          status: "completed" as const,
          summary: null,
          startedAt: NOW,
          completedAt: NOW,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      ]),
    ),
    executionLanes: {
      // Already carried into the session by a concluded join, so the band is
      // green and its member reads Published.
      research: lane("research", {
        status: "merged",
        includedContextIds: ["survey"],
      }),
      api: lane("api", {
        status: laneStatus("api"),
        includedContextIds: ["api-design", "api-impl"],
      }),
      ui: lane("ui", {
        status: laneStatus("ui"),
        includedContextIds: ["ui-impl"],
      }),
      [SESSION_LANE_ID]: SESSION_LANE,
    },
    joins: {
      "join-research": join("join-research", {
        sourceLaneIds: ["research"],
        mergedSourceLaneIds: ["research"],
        status: "succeeded",
        completedAt: NOW,
      }),
      "join-publish": publishJoin,
    },
    contextOutputs: {},
  });
}

const EMPTY_LAYOUT = {
  workflowId: "workflow-delivery",
  contextPositions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
};

/**
 * React Flow fits the viewport when nodes first measure — while every node
 * still sits at the origin, since these stories store no positions. Refit once
 * the generated geometry has actually placed them.
 */
const refitAfterLayout: NonNullable<Story["play"]> = async ({
  canvasElement,
}) => {
  await waitFor(
    () => {
      const transforms = new Set(
        [...canvasElement.querySelectorAll(".react-flow__node")].map(
          (node) => (node as HTMLElement).style.transform,
        ),
      );
      if (transforms.size < 2) {
        throw new Error("auto-layout has not placed the nodes yet");
      }
    },
    { timeout: 5000 },
  );
  await userEvent.click(
    await within(canvasElement).findByRole("button", { name: "Fit view" }),
  );
};

const meta = {
  title: "SessionWorkflow/WorkflowExecutionCanvas",
  component: WorkflowExecutionCanvas,
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  args: {
    layout: EMPTY_LAYOUT,
    onSelectContext: fn(),
    selectedContextId: null,
  },
  decorators: [
    (StoryFn) => (
      <div style={{ display: "flex", height: "100vh", width: "100%" }}>
        <StoryFn />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowExecutionCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The delivery window, with all four states of "where is this work" on screen
 * at once:
 *
 * - `research` merged and concluded — band green, `Survey code` **Published**.
 * - `api` merged by the running publish but not yet concluded — **In lane**,
 *   dashed, naming the lane it is headed for.
 * - `ui` still being carried by that publish — **Merging → cc/checkout-v2**.
 * - `report` read-only on the session lane — **Completed**, because it writes
 *   nothing and so owes no merge at all.
 *
 * The publication pill reads `publishing: … 1 of 2 lanes merged` in cyan: work
 * in flight, not the met precondition the old copy reported.
 */
export const MidMerge = {
  args: {
    execution: deliveryExecution(
      join("join-publish", {
        kind: "final_publish",
        sourceLaneIds: ["api", "ui"],
        mergedSourceLaneIds: ["api"],
        status: "running",
      }),
    ),
  },
  play: refitAfterLayout,
} satisfies Story;

/**
 * The same run once the publish concluded: every write-mode member reads
 * Published, every band is green, and the pill states the outcome.
 */
export const Published = {
  args: {
    execution: deliveryExecution(
      join("join-publish", {
        kind: "final_publish",
        sourceLaneIds: ["api", "ui"],
        mergedSourceLaneIds: ["api", "ui"],
        status: "succeeded",
        completedAt: NOW,
      }),
    ),
  },
  play: refitAfterLayout,
} satisfies Story;

/**
 * A publish that hit conflicts. The pill turns red and states the count it
 * actually recorded; the members stay In lane, because their work is still
 * sitting in the lane worktrees exactly where the failed merge left it.
 */
export const PublishFailed = {
  args: {
    execution: deliveryExecution(
      join("join-publish", {
        kind: "final_publish",
        sourceLaneIds: ["api", "ui"],
        mergedSourceLaneIds: ["api"],
        status: "conflicts",
        completedAt: NOW,
        conflicts: {
          files: ["src/api/routes.ts", "src/ui/panel.tsx", "src/shared/types.ts"],
          message: "Automatic resolution failed on 3 files",
          analysis: null,
        },
      }),
    ),
  },
  play: refitAfterLayout,
} satisfies Story;

/**
 * The state the whole delivery vocabulary exists to be distinguishable FROM: no
 * join has run, so every member is In lane and the pill still names the
 * precondition. Read beside `MidMerge`, this is what the canvas used to show
 * for both.
 */
export const AwaitingPublish = {
  args: {
    execution: deliveryExecution(
      join("join-publish", {
        kind: "final_publish",
        sourceLaneIds: ["api", "ui"],
        status: "pending",
      }),
    ),
  },
  play: refitAfterLayout,
} satisfies Story;
