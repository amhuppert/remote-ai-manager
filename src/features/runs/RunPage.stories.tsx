import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { RunPage, type RunPageActions } from "./components/RunPage";
import {
  checkoutRun,
  checkoutHaltedRun,
  checkoutLoopRun,
  checkoutSucceededRun,
  noticeRun,
  noticeRunAwaitingApproval,
  sessionRuns,
} from "./fixtures";
import type { ContextDetail, RunDetail } from "@/components/runs/model";

const actions: RunPageActions = {
  onSelectRun: fn(),
  onBrowseTemplates: fn(),
  onPause: fn(),
  onResume: fn(),
  onCancel: fn(),
  onRetryLane: fn(),
  onApplyRemedy: fn(),
  onApprove: fn(),
  onReject: fn(),
  onOpenConversation: fn(),
};

/** The afternoon the fixtures describe, so elapsed times read as written. */
const NOW = Date.parse("2026-10-08T19:56:00.000Z");
const LATER = Date.parse("2026-10-08T20:56:00.000Z");

function withContext(
  run: RunDetail,
  key: string,
  change: (context: ContextDetail) => ContextDetail,
): RunDetail {
  return {
    ...run,
    contexts: run.contexts.map((context) =>
      context.key === key ? change(context) : context,
    ),
  };
}

const pausedRun: RunDetail = {
  ...checkoutLoopRun,
  status: { kind: "paused", draining: false },
  contexts: checkoutLoopRun.contexts.map((context) =>
    context.state.kind === "running"
      ? {
          ...context,
          state: { kind: "paused", next: context.state.step, draining: false },
        }
      : context,
  ),
};

const questionRun: RunDetail = withContext(
  {
    ...checkoutLoopRun,
    attention: [
      {
        kind: "question",
        questionId: "question-polish-copy",
        contextKey: "polish",
        contextTitle: "Polish copy and empty states",
        seat: "copy reviewer",
        question:
          "The content guide says “Pay now” but the spec says “Place order”. Which wins on the confirm button?",
        askedAt: "2026-10-08T20:54:00.000Z",
      },
    ],
  },
  "polish",
  (context) => ({
    ...context,
    state: { kind: "awaiting_answer" },
    questions: [
      {
        questionId: "question-polish-copy",
        seat: "reviewer-1",
        question:
          "The content guide says “Pay now” but the spec says “Place order”. Which wins on the confirm button?",
        askedAt: "2026-10-08T20:54:00.000Z",
      },
    ],
    stages: context.stages.map((stage) =>
      stage.key === "review"
        ? { ...stage, state: "waiting", note: "question" }
        : stage,
    ),
  }),
);

const laneBlockedRun: RunDetail = {
  ...checkoutRun,
  attention: [
    {
      kind: "run_halt",
      occurrence: "lane-ui-publication-1",
      halt: "lane_publication",
      detail:
        "The session worktree has uncommitted changes in src/checkout/; publishing would overwrite them.",
      clearedBy: "retry_lane",
      lane: "ui",
      at: "2026-10-08T19:55:00.000Z",
    },
  ],
  contexts: checkoutRun.contexts.map((context) =>
    context.key === "ui"
      ? (checkoutHaltedRun.contexts.find((item) => item.key === "ui") ??
        context)
      : context,
  ),
  lanes: checkoutRun.lanes.map((lane) =>
    lane.key === "ui"
      ? {
          ...lane,
          state: "blocked",
          attempt: 1,
          detail: "session worktree has uncommitted changes",
        }
      : lane,
  ),
};

const succeededRun = checkoutSucceededRun;

function runsFor(run: RunDetail) {
  return sessionRuns.map((summary) =>
    summary.runId !== run.runId
      ? summary
      : {
          ...summary,
          status: run.status,
          attention: run.attention.filter((item) => item.kind !== "question")
            .length,
          contexts: {
            done: run.contexts.filter(
              (context) => context.state.kind === "succeeded",
            ).length,
            total: run.contexts.filter(
              (context) => context.state.kind !== "skipped",
            ).length,
          },
          costUsd: run.costUsd,
          finishedAt: run.finishedAt,
        },
  );
}

const meta = {
  title: "Runs/Run page",
  component: RunPage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[100dvh]">
        <Story />
      </div>
    ),
  ],
  args: { runs: sessionRuns, run: checkoutRun, actions, now: NOW },
} satisfies Meta<typeof RunPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The UI awaits approval; session writers wait for its lane to publish. */
export const NeedsYou: Story = {};

/** The approval the run waits on, opened from Needs you. */
export const ReviewApproval: Story = { args: { initialContext: "ui" } };

/** A halted context with the remedies its halt allows. */
export const ResolveHalt: Story = {
  args: {
    run: checkoutHaltedRun,
    runs: runsFor(checkoutHaltedRun),
    initialContext: "migrate",
    now: LATER,
  },
};

/** A loop pass under review, one reviewer done. */
export const LoopUnderReview: Story = {
  args: {
    run: checkoutLoopRun,
    runs: runsFor(checkoutLoopRun),
    initialContext: "polish",
    now: LATER,
  },
};

/** A context that has not started, and why. */
export const WaitingContext: Story = { args: { initialContext: "integrate" } };

/** A route not taken. */
export const SkippedContext: Story = { args: { initialContext: "docs" } };

/** The same run as its read-only dependency diagram. */
export const Diagram: Story = { args: { initialView: "diagram" } };

/** The diagram with a context selected. */
export const DiagramWithSelection: Story = {
  args: { initialView: "diagram", initialContext: "ui" },
};

/** A seat's question in the owner conversation's hands: shown, not answered here. */
export const QuestionWithTheOwner: Story = {
  args: {
    run: questionRun,
    runs: runsFor(questionRun),
    initialContext: "polish",
    now: LATER,
  },
};

/** A lane that could not publish, with its retry. */
export const LaneBlocked: Story = {
  args: { run: laneBlockedRun, runs: runsFor(laneBlockedRun) },
};

/** Paused: running contexts hold their next step. */
export const Paused: Story = {
  args: {
    run: pausedRun,
    runs: runsFor(pausedRun),
    initialContext: "polish",
    now: LATER,
  },
};

/** A halt keeps its remedies visible while the run is paused. */
const pausedHaltRun: RunDetail = {
  ...checkoutHaltedRun,
  status: { kind: "paused", draining: false },
};
export const PausedWithHalt: Story = {
  args: {
    run: pausedHaltRun,
    runs: runsFor(pausedHaltRun),
    initialContext: "migrate",
    now: LATER,
  },
};

/** Finished: everything done, one route skipped. */
export const Succeeded: Story = {
  args: {
    run: succeededRun,
    runs: runsFor(succeededRun),
  },
};

/** A standalone agent run: one context, shown in full. */
export const AgentRun: Story = { args: { run: noticeRun } };

/** The agent run once its result waits for approval. */
export const AgentRunAwaitingApproval: Story = {
  args: {
    run: noticeRunAwaitingApproval,
    runs: runsFor(noticeRunAwaitingApproval),
    now: Date.parse("2026-10-08T20:08:00.000Z"),
  },
};

/** The first visit still provides a route to run templates. */
export const Empty: Story = { args: { runs: [], run: null } };
export const Loading: Story = { args: { run: null, loading: true } };
export const LoadFailed: Story = {
  args: {
    run: null,
    error:
      "The server could not return this session’s runs. Your work is preserved.",
    onRetry: fn(),
  },
};

/** A settled receipt that the run could not reconcile can be retried explicitly. */
export const RecoveryNeeded: Story = {
  args: {
    run: {
      ...checkoutRun,
      status: { kind: "needs_input" },
      attention: [
        {
          kind: "run_halt",
          halt: "reconcile_failed",
          clearedBy: "resume",
          occurrence: "run-reconcile-1",
          detail:
            "The publication finished, but its recorded result could not be applied. Resume to reconcile the recorded outcome and continue.",
          at: "2026-10-08T19:55:00.000Z",
        },
      ],
    },
  },
};

const uncertainRun = withContext(
  {
    ...checkoutHaltedRun,
    attention: [
      {
        kind: "halt",
        contextKey: "migrate",
        contextTitle: "Migrate the orders table",
        halt: "effect_uncertain",
        detail:
          "The attempt stopped after dispatch; inspect the work before deciding.",
        at: "2026-10-08T20:55:00.000Z",
      },
    ],
  },
  "migrate",
  (context) => ({
    ...context,
    state: {
      kind: "halted",
      halt: {
        kind: "effect_uncertain",
        occurrence: "uncertain-1",
        at: "2026-10-08T20:55:00.000Z",
        detail:
          "The previous attempt stopped after dispatch. Inspect the work before authorizing another attempt.",
        remedies: [{ kind: "continue" }, { kind: "confirm_effect" }],
      },
    },
  }),
);
export const UncertainEffect: Story = {
  args: {
    initialContext: "migrate",
    run: uncertainRun,
    runs: runsFor(uncertainRun),
    now: LATER,
  },
};

/** Background failures preserve the loaded run and its inspection state. */
export const RefreshFailed: Story = {
  args: { run: checkoutRun, error: "Server reconnecting", onRetry: fn() },
};
/** Documents → plan.md reports an unavailable frozen revision rather than substituting current content. */
export const FrozenEvidenceUnavailable: Story = {
  args: {
    run: { ...checkoutRun, documentHistory: [] },
    initialContext: "plan",
  },
};
