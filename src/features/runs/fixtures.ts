import { z } from "zod";
import { materializeRunTemplate } from "@/lib/run-templates/document";
import { checkoutTemplate } from "./template-fixtures";
import { contentOf } from "./template-model";
import { dependenciesOf } from "./template-structure";
import type {
  CandidateChanges,
  ContextDetail,
  ContextConfiguration,
  ContextInvocation,
  ContextStage,
  RunCharter,
  RunDetail,
  RunOwner,
  RunSummary,
  SeatSummary,
} from "@/components/runs/model";

/**
 * Engine-possible snapshots of one workflow: approval before publication,
 * a migration halt after publication, then a later polish loop. The same
 * authored topology supplies every snapshot, the template, and the diagram.
 */

const day = (time: string): string => `2026-10-08T${time}:00.000Z`;
/** The workflow a person launched from the checkout template, as its run recorded it. */
const launched = materializeRunTemplate(contentOf(checkoutTemplate), {
  flag: "checkout-v2",
});
if (!launched.ok)
  throw new Error(
    `The checkout template does not launch: ${launched.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
  );
const launchedDefinition = launched.request;

function configuration(
  overrides: Partial<ContextConfiguration> = {},
): ContextConfiguration {
  return {
    checks: ["typecheck", "lint"],
    deferredChecks: [],
    ownerQuestions: true,
    allowTaskAddition: false,
    documentPublishing: true,
    scope: { mode: "full" },
    worktreePath: "/repo/.worktrees/checkout-v2",
    branch: "csm/checkout-v2",
    outputSchema: null,
    policy: {
      unfinishedTaskRetries: { used: 0, limit: 2 },
      validationRetries: { used: 0, limit: 3 },
      captureRepairLimit: 2,
      instabilityLimit: 3,
      adviceCorrectionLimit: 2,
      invocationTimeoutMs: 30 * 60_000,
    },
    ...overrides,
  };
}

export const owner: RunOwner = {
  conversationId: "c-7f3a9e21-4b0d-4c55-9a51-2b7e0c1d9f40",
  title: "Release readiness review",
  backend: "claude",
};

/** A reviewer's assignment, named after its focus. */
const assignmentOf = (focus: string): string =>
  focus.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const opus: SeatSummary = {
  assignment: "implementer",
  role: "implementer",
  backend: "claude",
  model: "Opus 5.5",
  effort: "high",
};
const sol = (
  focus: string,
  authority: "blocking" | "advisory" = "blocking",
): SeatSummary => ({
  assignment: assignmentOf(focus),
  role: "reviewer",
  backend: "codex",
  model: "GPT-6 Sol",
  effort: "high",
  authority,
  focus,
});
const sonnetReviewer = (
  focus: string,
  authority: "blocking" | "advisory" = "advisory",
): SeatSummary => ({
  assignment: assignmentOf(focus),
  role: "reviewer",
  backend: "claude",
  model: "Sonnet 5.5",
  effort: "medium",
  authority,
  focus,
});

function stages(
  states: Partial<
    Record<ContextStage["key"], Pick<ContextStage, "state" | "note">>
  >,
  approval: boolean,
): ContextStage[] {
  const all: Array<Pick<ContextStage, "key" | "label">> = [
    { key: "workspace", label: "Workspace" },
    { key: "work", label: "Work" },
    { key: "output", label: "Result" },
    { key: "review", label: "Review" },
    ...(approval ? [{ key: "approval" as const, label: "Approval" }] : []),
    { key: "accept", label: "Accept" },
  ];
  return all.map((stage) => ({
    ...stage,
    state: "pending",
    ...states[stage.key],
  }));
}

const allDone = (approval = false): ContextStage[] =>
  stages(
    {
      workspace: { state: "done" },
      work: { state: "done" },
      output: { state: "done" },
      review: { state: "done" },
      approval: { state: "done" },
      accept: { state: "done" },
    },
    approval,
  );

const uiCandidate: CandidateChanges = {
  status: "ready",
  scope: "owned",
  ownedPaths: ["src/checkout/ui", "src/checkout/copy.ts"],
  diff: {
    totalAdditions: 61,
    totalDeletions: 9,
    files: [
      {
        filePath: "src/checkout/ui/PaymentStep.tsx",
        additions: 38,
        deletions: 6,
        hunks: [
          {
            header:
              "@@ -12,9 +12,14 @@ export function PaymentStep({ order }: PaymentStepProps) {",
            lines: [
              {
                type: "hunk-header",
                content:
                  "@@ -12,9 +12,14 @@ export function PaymentStep({ order }: PaymentStepProps) {",
              },
              {
                type: "context",
                content: "  const total = useOrderTotal(order);",
              },
              {
                type: "remove",
                content: "  if (!order.paymentMethod) return <EmptyPayment />;",
              },
              { type: "add", content: "  if (!order.paymentMethod) {" },
              {
                type: "add",
                content:
                  "    return <EmptyPayment onAdd={openPaymentSheet} />;",
              },
              { type: "add", content: "  }" },
              { type: "context", content: "  return (" },
              {
                type: "context",
                content: '    <section aria-labelledby="payment-title">',
              },
            ],
          },
        ],
      },
      {
        filePath: "src/checkout/copy.ts",
        additions: 23,
        deletions: 3,
        hunks: [
          {
            header: "@@ -1,6 +1,9 @@",
            lines: [
              { type: "hunk-header", content: "@@ -1,6 +1,9 @@" },
              {
                type: "remove",
                content: 'export const PAYMENT_EMPTY = "No payment method";',
              },
              {
                type: "add",
                content:
                  'export const PAYMENT_EMPTY = "Add a payment method to continue";',
              },
              {
                type: "add",
                content: 'export const PAYMENT_ADD = "Add payment method";',
              },
            ],
          },
        ],
      },
    ],
  },
};

const plan: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({ scope: { mode: "readOnly" } }),
  previousInvocations: [],
  invocationId: "checkout-plan-1",
  questions: [],
  candidate: null,
  key: "plan",
  title: "Plan the rollout",
  placement: { kind: "session" },
  loop: null,
  dependsOn: [],
  state: { kind: "succeeded", at: day("18:31") },
  tasks: { done: 3, total: 3 },
  costUsd: 1.12,
  implementer: opus,
  reviewers: [sol("Feasibility")],
  humanApproval: false,
  startedAt: day("18:14"),
  brief:
    "Read the checkout v2 spec and the current checkout code. Return the rollout plan: the order of work, the API contract, the migration and the flag rollout.",
  taskList: [
    { id: "t1", title: "Read the spec and the current checkout", done: true },
    { id: "t2", title: "Draft the rollout plan", done: true },
    { id: "t3", title: "Return the rollout plan", done: true },
  ],
  criteria: [
    {
      id: "ac-1",
      text: "plan.md orders the work so the API lands before the UI uses it",
    },
    { id: "ac-2", text: "The v1 API stays unchanged" },
  ],
  stages: allDone(),
  reviews: [
    {
      number: 1,
      kind: "full",
      outcome: "passed",
      at: day("18:27"),
      checks: [],
      seats: [
        {
          assignment: "reviewer-1",
          seat: sol("Feasibility"),
          status: "pass",
          findings: [],
          advisories: [],
        },
      ],
    },
  ],
  output: {
    status: "accepted",
    value: {
      summary:
        "Returned the rollout plan: API and UI lanes publish before migration, then polish and integration.",
    },
  },
  inputs: [],
  agents: [
    {
      conversationId: "c-1a2b3c4d-plan-impl",
      assignment: "implementer",
      seat: opus,
      status: "finished",
      turns: 2,
      costUsd: 0.81,
    },
    {
      conversationId: "c-5e6f7a8b-plan-rev",
      assignment: "reviewer-1",
      seat: sol("Feasibility"),
      status: "finished",
      turns: 1,
      costUsd: 0.31,
    },
  ],
  froze: {
    charter: 1,
    documents: [
      { path: "plan.md", revision: 1, later: "superseded" },
      { path: "glossary.md", revision: 1, later: null },
    ],
  },
  approval: null,
  lastSummary:
    "Returned the rollout plan: API and UI lanes publish before migration, then polish and integration.",
};

const api: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({
    scope: { mode: "owned", paths: ["src/api", "src/orders"] },
    worktreePath: "/repo/.worktrees/checkout-v2.1-api",
    branch: "csm/checkout-v2-1-api",
  }),
  previousInvocations: [],
  invocationId: "checkout-api-1",
  questions: [],
  candidate: null,
  key: "api",
  title: "Build the orders API",
  placement: { kind: "lane", lane: "api" },
  loop: null,
  dependsOn: ["plan"],
  state: { kind: "succeeded", at: day("19:22") },
  tasks: { done: 4, total: 4 },
  costUsd: 4.86,
  implementer: opus,
  reviewers: [sol("Correctness"), sonnetReviewer("API design")],
  humanApproval: false,
  startedAt: day("18:32"),
  brief:
    "Add the v2 orders endpoints described in plan.md behind the checkout-v2 flag. Keep the v1 handlers as they are.",
  taskList: [
    { id: "t1", title: "Add POST /v2/orders", done: true },
    { id: "t2", title: "Add GET /v2/orders/:id", done: true },
    { id: "t3", title: "Contract tests for both", done: true },
    { id: "t4", title: "Publish api-contract.md", done: true },
  ],
  criteria: [
    {
      id: "ac-1",
      text: "Both endpoints validate input with the shared schemas",
    },
    { id: "ac-2", text: "v1 contract tests still pass" },
  ],
  stages: allDone(),
  reviews: [
    {
      number: 1,
      kind: "full",
      outcome: "passed",
      at: day("19:14"),
      checks: [
        { command: "typecheck", status: "passed", durationMs: 41_000 },
        { command: "test", status: "passed", durationMs: 312_000 },
      ],
      seats: [
        {
          assignment: "reviewer-1",
          seat: sol("Correctness"),
          status: "pass",
          findings: [],
          advisories: [],
        },
        {
          assignment: "reviewer-2",
          seat: sonnetReviewer("API design"),
          status: "pass",
          findings: [],
          advisories: [
            {
              title: "Return 409 for a duplicate idempotency key",
              description:
                "A repeated key returns 200 with the first order; 409 would make the retry visible.",
              disposition: "declined",
              dispositionNote:
                "The spec asks for the first order back so retries are safe.",
            },
          ],
        },
      ],
    },
  ],
  output: {
    status: "accepted",
    value: {
      endpoints: ["POST /v2/orders", "GET /v2/orders/:id"],
      publicChanges: false,
      contract: "api-contract.md",
    },
  },
  inputs: [
    {
      key: "plan",
      title: "Plan the rollout",
      output: { summary: "Returned the accepted rollout plan." },
    },
  ],
  agents: [
    {
      conversationId: "c-9a8b7c6d-api-impl",
      assignment: "implementer",
      seat: opus,
      status: "finished",
      turns: 3,
      costUsd: 3.5,
    },
    {
      conversationId: "c-1f2e3d4c-api-rev1",
      assignment: "reviewer-1",
      seat: sol("Correctness"),
      status: "finished",
      turns: 1,
      costUsd: 0.92,
    },
    {
      conversationId: "c-5b6a7988-api-rev2",
      assignment: "reviewer-2",
      seat: sonnetReviewer("API design"),
      status: "finished",
      turns: 1,
      costUsd: 0.44,
    },
  ],
  froze: {
    charter: 1,
    documents: [
      { path: "plan.md", revision: 2, later: null },
      { path: "glossary.md", revision: 1, later: null },
    ],
  },
  approval: null,
  lastSummary:
    "Both endpoints are in, with contract tests; api-contract.md is published.",
};

const migrate: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({
    scope: { mode: "owned", paths: ["db"] },
    checks: ["typecheck", "test"],
  }),
  previousInvocations: [],
  invocationId: "checkout-migrate-1",
  questions: [],
  candidate: null,
  key: "migrate",
  title: "Migrate the orders table",
  placement: { kind: "session" },
  loop: null,
  dependsOn: ["plan", "api", "ui"],
  state: {
    kind: "halted",
    halt: {
      kind: "turn_failed",
      detail:
        "Codex stream closed before the turn finished (stream_error after 4m 12s).",
      occurrence: "occ-migrate-3",
      at: day("20:06"),
      seat: "implementer",
      remedies: [
        { kind: "continue" },
        { kind: "replace_seat" },
        { kind: "confirm_effect" },
      ],
    },
  },
  tasks: { done: 1, total: 3 },
  costUsd: 2.03,
  implementer: {
    assignment: "implementer",
    role: "implementer",
    backend: "codex",
    model: "GPT-6 Sol",
    effort: "high",
  },
  reviewers: [sonnetReviewer("Data safety", "blocking")],
  humanApproval: false,
  startedAt: day("19:54"),
  brief:
    "Add the v2 columns to orders with a reversible migration. Backfill in batches; never lock the table.",
  taskList: [
    { id: "t1", title: "Write the migration", done: true },
    { id: "t2", title: "Batch backfill", done: false },
    { id: "t3", title: "Rollback test", done: false },
  ],
  criteria: [
    {
      id: "ac-1",
      text: "The migration runs and rolls back on a copy of production data",
    },
    { id: "ac-2", text: "No statement holds a table lock longer than 1s" },
  ],
  stages: stages(
    { workspace: { state: "done" }, work: { state: "halted", note: "turn 2" } },
    false,
  ),
  reviews: [],
  output: null,
  inputs: [
    {
      key: "plan",
      title: "Plan the rollout",
      output: { summary: "Returned the accepted rollout plan." },
    },
  ],
  agents: [
    {
      conversationId: "c-2c3d4e5f-mig-impl",
      assignment: "implementer",
      seat: {
        assignment: "implementer",
        role: "implementer",
        backend: "codex",
        model: "GPT-6 Sol",
        effort: "high",
      },
      status: "idle",
      turns: 2,
      costUsd: 2.03,
    },
  ],
  froze: {
    charter: 1,
    documents: [{ path: "plan.md", revision: 2, later: null }],
  },
  approval: null,
  lastSummary: "Wrote 0042_orders_v2.sql; started the batch backfill.",
};

const ui: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({
    scope: {
      mode: "owned",
      paths: ["src/checkout/ui", "src/checkout/copy.ts"],
    },
    worktreePath: "/repo/.worktrees/checkout-v2.1-ui",
    branch: "csm/checkout-v2-1-ui",
  }),
  previousInvocations: [],
  invocationId: "checkout-ui-1",
  questions: [],
  candidate: uiCandidate,
  key: "ui",
  title: "Build the checkout UI",
  placement: { kind: "lane", lane: "ui" },
  loop: null,
  dependsOn: ["plan", "api"],
  state: { kind: "awaiting_approval", requestedAt: day("19:48") },
  tasks: { done: 3, total: 3 },
  costUsd: 6.4,
  implementer: opus,
  reviewers: [sol("Correctness"), sonnetReviewer("Accessibility")],
  humanApproval: true,
  startedAt: day("19:23"),
  brief:
    "Build the payment, review and confirmation steps on the v2 API. Follow the copy in the spec; empty states point at the next action.",
  taskList: [
    { id: "t1", title: "Payment step", done: true },
    { id: "t2", title: "Review and confirmation steps", done: true },
    { id: "t3", title: "Empty and error states", done: true },
  ],
  criteria: [
    { id: "ac-1", text: "Every step works with the keyboard alone" },
    { id: "ac-2", text: "A missing payment method offers to add one" },
    { id: "ac-3", text: "The UI calls only the v2 endpoints" },
  ],
  stages: stages(
    {
      workspace: { state: "done" },
      work: { state: "done", note: "fixed once" },
      output: { state: "done" },
      review: { state: "done", note: "round 2" },
      approval: { state: "waiting" },
    },
    true,
  ),
  reviews: [
    {
      number: 2,
      kind: "blocking",
      outcome: "passed",
      at: day("19:46"),
      checks: [
        { command: "typecheck", status: "passed", durationMs: 38_000 },
        { command: "lint", status: "passed", durationMs: 22_000 },
      ],
      seats: [
        {
          assignment: "reviewer-1",
          seat: sol("Correctness"),
          status: "pass",
          findings: [],
          advisories: [],
        },
      ],
    },
    {
      number: 1,
      kind: "full",
      outcome: "failed",
      at: day("19:36"),
      checks: [
        { command: "typecheck", status: "passed", durationMs: 40_000 },
        {
          command: "lint",
          status: "failed",
          durationMs: 21_000,
          detail: "2 errors in src/checkout/ui/PaymentStep.tsx",
        },
      ],
      seats: [
        {
          assignment: "reviewer-1",
          seat: sol("Correctness"),
          status: "fail",
          findings: [
            {
              criterionId: "ac-2",
              title: "Empty payment state has no way forward",
              description:
                "EmptyPayment renders a message with no action; the criterion asks it to offer adding a method.",
            },
          ],
          advisories: [],
        },
        {
          assignment: "reviewer-2",
          seat: sonnetReviewer("Accessibility"),
          status: "pass",
          findings: [],
          advisories: [
            {
              title: "Announce step changes",
              description:
                "Move focus to the step heading on change so screen readers announce it.",
              disposition: "addressed",
            },
            {
              title: "Larger hit area for the edit links",
              description: "The edit links are 18px tall.",
              disposition: "deferred",
              dispositionNote:
                "Belongs to the design-system pass in the polish loop.",
            },
          ],
        },
      ],
    },
  ],
  output: {
    status: "candidate",
    value: {
      steps: ["payment", "review", "confirmation"],
      endpointsUsed: ["POST /v2/orders", "GET /v2/orders/:id"],
    },
  },
  inputs: [
    {
      key: "plan",
      title: "Plan the rollout",
      output: { summary: "Returned the accepted rollout plan." },
    },
    {
      key: "api",
      title: "Build the orders API",
      output: {
        endpoints: ["POST /v2/orders", "GET /v2/orders/:id"],
        publicChanges: false,
      },
    },
  ],
  agents: [
    {
      conversationId: "c-3d4e5f60-ui-impl",
      assignment: "implementer",
      seat: opus,
      status: "idle",
      turns: 3,
      costUsd: 4.29,
    },
    {
      conversationId: "c-7a8b9c0d-ui-rev1",
      assignment: "reviewer-1",
      seat: sol("Correctness"),
      status: "finished",
      turns: 2,
      costUsd: 1.59,
    },
    {
      conversationId: "c-0e1f2a3b-ui-rev2",
      assignment: "reviewer-2",
      seat: sonnetReviewer("Accessibility"),
      status: "finished",
      turns: 1,
      costUsd: 0.52,
    },
  ],
  froze: {
    charter: 1,
    documents: [
      { path: "plan.md", revision: 2, later: null },
      { path: "api-contract.md", revision: 1, later: null },
      { path: "glossary.md", revision: 1, later: null },
    ],
  },
  approval: { candidateId: "candidate-ui-2", requestedAt: day("19:48") },
  lastSummary:
    "The three steps are done. The empty payment state now offers to add a method; focus moves to each step heading.",
};

const polish: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({
    checks: ["lint"],
    scope: { mode: "owned", paths: ["src/checkout/copy.ts"] },
    outputSchema: z.toJSONSchema(
      z.object({ approved: z.boolean(), changes: z.number().int() }),
    ),
  }),
  previousInvocations: [],
  invocationId: "checkout-polish-2",
  questions: [],
  candidate: null,
  key: "polish",
  title: "Polish copy and empty states",
  placement: { kind: "session" },
  loop: { key: "polish", pass: 2, maxPasses: 3 },
  dependsOn: ["migrate"],
  state: {
    kind: "running",
    step: {
      kind: "review",
      round: 1,
      roundKind: "full",
      reviewersDone: 1,
      reviewersTotal: 2,
    },
  },
  tasks: { done: 2, total: 2 },
  costUsd: 1.94,
  implementer: {
    assignment: "implementer",
    role: "implementer",
    backend: "claude",
    model: "Sonnet 5.5",
    effort: "medium",
  },
  reviewers: [
    sonnetReviewer("Copy", "blocking"),
    sol("Consistency", "advisory"),
  ],
  humanApproval: false,
  startedAt: day("20:39"),
  brief:
    "Bring the checkout copy and empty states in line with the content guide. The reviewer approves when nothing is left to change.",
  taskList: [
    { id: "t1", title: "Apply the content guide to checkout copy", done: true },
    { id: "t2", title: "Review every empty state", done: true },
  ],
  criteria: [{ id: "ac-1", text: "Copy follows the content guide" }],
  stages: stages(
    {
      workspace: { state: "done" },
      work: { state: "done" },
      output: { state: "done" },
      review: { state: "current", note: "1 of 2" },
    },
    false,
  ),
  reviews: [
    {
      number: 1,
      kind: "full",
      outcome: "running",
      at: day("20:52"),
      checks: [{ command: "lint", status: "passed", durationMs: 19_000 }],
      seats: [
        {
          assignment: "reviewer-1",
          seat: sonnetReviewer("Copy", "blocking"),
          status: "pending",
          findings: [],
          advisories: [],
        },
        {
          assignment: "reviewer-2",
          seat: sol("Consistency", "advisory"),
          status: "pass",
          findings: [],
          advisories: [],
        },
      ],
    },
  ],
  output: { status: "candidate", value: { approved: false, changes: 14 } },
  inputs: [
    {
      key: "polish",
      title: "Pass 1 of polish",
      output: { approved: false, changes: 22 },
    },
  ],
  agents: [
    {
      conversationId: "c-4b5c6d7e-pol-impl",
      assignment: "implementer",
      seat: {
        assignment: "implementer",
        role: "implementer",
        backend: "claude",
        model: "Sonnet 5.5",
        effort: "medium",
      },
      status: "idle",
      turns: 1,
      costUsd: 1.21,
    },
    {
      conversationId: "c-8f9a0b1c-pol-rev1",
      assignment: "reviewer-1",
      seat: sonnetReviewer("Copy", "blocking"),
      status: "active",
      turns: 1,
      costUsd: 0.52,
    },
    {
      conversationId: "c-2d3e4f5a-pol-rev2",
      assignment: "reviewer-2",
      seat: sol("Consistency", "advisory"),
      status: "finished",
      turns: 1,
      costUsd: 0.21,
    },
  ],
  froze: {
    charter: 1,
    documents: [
      { path: "plan.md", revision: 2, later: null },
      { path: "glossary.md", revision: 1, later: null },
    ],
  },
  approval: null,
  lastSummary: "Rewrote 14 strings and three empty states.",
};

const integrate: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({
    scope: { mode: "readOnly" },
    checks: ["typecheck", "lint", "test"],
  }),
  previousInvocations: [],
  invocationId: null,
  questions: [],
  candidate: null,
  key: "integrate",
  title: "Check the assembled journey",
  placement: { kind: "session" },
  loop: null,
  dependsOn: ["ui", "migrate", "polish"],
  state: {
    kind: "waiting",
    dependencies: ["ui", "migrate", "polish"],
    provisionLanes: [],
    publicationLanes: ["ui"],
  },
  tasks: { done: 0, total: 2 },
  costUsd: null,
  implementer: opus,
  reviewers: [sol("End-to-end")],
  humanApproval: false,
  startedAt: null,
  brief:
    "Run the full checkout journey against the migrated schema with the flag on and off. Report what breaks.",
  taskList: [
    { id: "t1", title: "Journey with the flag on", done: false },
    { id: "t2", title: "Journey with the flag off", done: false },
  ],
  criteria: [
    {
      id: "ac-1",
      text: "Both journeys complete; any failure is reported with its step",
    },
  ],
  stages: stages({}, false),
  reviews: [],
  output: null,
  inputs: [],
  agents: [],
  froze: null,
  approval: null,
  lastSummary: null,
};

const docs: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({ scope: { mode: "owned", paths: ["docs"] } }),
  previousInvocations: [],
  invocationId: null,
  questions: [],
  candidate: null,
  key: "docs",
  title: "Update the public API docs",
  placement: { kind: "session" },
  loop: null,
  dependsOn: ["api", "integrate"],
  state: { kind: "skipped", reason: "api reported no public API changes" },
  tasks: { done: 0, total: 1 },
  costUsd: null,
  implementer: {
    assignment: "implementer",
    role: "implementer",
    backend: "claude",
    model: "Sonnet 5.5",
    effort: "low",
  },
  reviewers: [],
  humanApproval: false,
  startedAt: null,
  brief: "Update the public API reference for the v2 endpoints.",
  taskList: [{ id: "t1", title: "Update the reference", done: false }],
  criteria: [],
  stages: stages({}, false).map((stage) => ({ ...stage, state: "skipped" })),
  reviews: [],
  output: null,
  inputs: [],
  agents: [],
  froze: null,
  approval: null,
  lastSummary: null,
};

const { previousInvocations: _polishPasses, ...polishInvocation } = polish;
const polishFirstPass: ContextInvocation = {
  ...polishInvocation,
  invocationId: "checkout-polish-1",
  loop: { key: "polish", pass: 1, maxPasses: 3 },
  state: { kind: "succeeded", at: day("20:38") },
  startedAt: day("20:16"),
  stages: allDone(),
  costUsd: 1.52,
  reviews: [
    {
      number: 1,
      kind: "full",
      outcome: "passed",
      at: day("20:36"),
      checks: [{ command: "lint", status: "passed", durationMs: 18_000 }],
      seats: [
        {
          assignment: "reviewer-1",
          seat: sonnetReviewer("Copy", "blocking"),
          status: "pass",
          findings: [],
          advisories: [],
        },
      ],
    },
  ],
  output: { status: "accepted", value: { approved: false, changes: 22 } },
  inputs: [
    {
      key: "plan",
      title: "Plan the rollout",
      output: { summary: "Returned the accepted rollout plan." },
    },
  ],
  agents: [
    {
      conversationId: "c-polish-pass1-implementer",
      assignment: "implementer",
      seat: polish.implementer,
      status: "finished",
      turns: 1,
      costUsd: 1.21,
    },
    {
      conversationId: "c-polish-pass1-reviewer",
      assignment: "reviewer-1",
      seat: sonnetReviewer("Copy", "blocking"),
      status: "finished",
      turns: 1,
      costUsd: 0.31,
    },
  ],
  lastSummary:
    "Updated 22 strings. The copy is clearer; the empty payment and saved-card states need another pass.",
};

function waiting(
  context: ContextDetail,
  dependencies: string[],
  publicationLanes: string[] = [],
): ContextDetail {
  return {
    ...context,
    invocationId: null,
    state: {
      kind: "waiting",
      dependencies,
      provisionLanes: [],
      publicationLanes,
    },
    loop: context.loop,
    tasks: { done: 0, total: context.taskList.length },
    taskList: context.taskList.map((task) => ({ ...task, done: false })),
    costUsd: null,
    startedAt: null,
    stages: stages({}, context.humanApproval),
    reviews: [],
    output: null,
    inputs: [],
    agents: [],
    froze: null,
    approval: null,
    lastSummary: null,
    previousInvocations: [],
    candidate: null,
    questions: [],
  };
}

const waitingMigrate = waiting(migrate, ["ui"], ["ui"]);
const waitingPolish = waiting(polish, ["migrate"]);
const checkoutContexts = [
  plan,
  api,
  waitingMigrate,
  ui,
  waitingPolish,
  integrate,
  docs,
];

const launchCharter: RunCharter = {
  revision: 1,
  source: "launch",
  at: day("18:10"),
  reason: null,
  mission:
    "Ship checkout v2 behind the checkout-v2 flag without changing the v1 API.",
  conventions: ["Use existing UI primitives and shared request schemas."],
  vocabulary: [
    "Order: a confirmed basket. Payment method: a saved card or wallet.",
  ],
  testStrategy:
    "Pin regressions at the service boundary, then verify the assembled checkout journey.",
  knownAmbiguities: [],
  invariants: [
    {
      id: "keep-v1-api",
      statement:
        "v1 handlers, routes and response shapes stay byte-for-byte as they are.",
    },
    {
      id: "no-internal-mocks",
      statement: "Tests never vi.mock internal modules.",
    },
    {
      id: "no-table-locks",
      statement: "No migration statement holds a table lock longer than 1s.",
      appliesTo: ["migrate"],
    },
  ],
  sources: [
    {
      rank: 1,
      label: "Checkout v2 spec",
      locator: "specs/checkout-v2.md",
      description: "Behaviour and copy the release must match",
    },
    {
      rank: 2,
      label: "Payments design",
      locator: "docs/design/payments.md",
      description: "Service boundaries and the flag rollout",
    },
    {
      rank: 3,
      label: "Current checkout",
      locator: "src/checkout/",
      description: "How v1 works today",
    },
  ],
  nonGoals: ["Multi-currency pricing", "Saved-cart sync across devices"],
};

export const checkoutRun: RunDetail = {
  runId: "run-8c1f4e2a-93b7-4d1c-b0a6-5e2f7d3c9a10",
  title: "Checkout v2 rollout",
  kind: "workflow",
  status: { kind: "needs_input" },
  owner,
  costComplete: true,
  origin: null,
  definitionRevision: 2,
  startedAt: day("18:14"),
  finishedAt: null,
  costUsd: checkoutContexts.reduce(
    (sum, context) => sum + (context.costUsd ?? 0),
    0,
  ),
  attention: [
    {
      kind: "approval",
      contextKey: "ui",
      contextTitle: ui.title,
      requestedAt: day("19:48"),
      reviewersPassed: 2,
    },
  ],
  contexts: checkoutContexts,
  edges: checkoutTemplate.workflow.contexts.flatMap((context) =>
    dependenciesOf(context).map((dependency) => ({
      from: dependency.key,
      to: context.key,
      guard:
        dependency.guard === null
          ? null
          : { label: dependency.guard, state: "not_taken" as const },
      outputOnly: dependency.outputOnly,
    })),
  ),
  lanes: [
    {
      key: "api",
      branch: "csm/checkout-v2-1-api",
      worktreePath: "/repo/.worktrees/checkout-v2.1-api",
      state: "published",
      attempt: 1,
      detail: null,
      commit: "a41c9e0",
      checks: ["typecheck", "test"],
    },
    {
      key: "ui",
      branch: "csm/checkout-v2-1-ui",
      worktreePath: "/repo/.worktrees/checkout-v2.1-ui",
      state: "working",
      attempt: null,
      detail: null,
      commit: null,
      checks: ["typecheck", "lint"],
    },
  ],
  loops: [
    {
      key: "polish",
      body: ["polish"],
      pass: 0,
      maxPasses: 3,
      state: "unstarted",
      until: "the copy reviewer approves",
    },
  ],
  documentHistory: [
    {
      path: "plan.md",
      revision: 1,
      source: "launch",
      at: day("18:10"),
      description: "Initial rollout outline",
      bytes: 145,
      contents:
        "# Initial rollout outline\n\nConfirm the API boundary before choosing the migration order. Keep all changes behind the checkout-v2 flag.\n",
    },
  ],
  charterHistory: [launchCharter],
  documents: [
    {
      path: "plan.md",
      revision: 2,
      source: "amend",
      at: day("19:20"),
      reason:
        "The owner retained the accepted rollout plan for later contexts.",
      description:
        "The rollout plan: order of work, API contract, migration and flag rollout",
      readWhen: "Before you start",
      bytes: 6_412,
      contents:
        "# Checkout v2 rollout\n\n## Order of work\n\n1. API (`/v2/orders`) in its own lane.\n2. UI in its own lane, after the API publishes.\n3. Both lanes publish before the session migration.\n4. Polish the copy, then check the assembled journey.\n\n## Flag\n\nEverything ships behind `checkout-v2`. The v1 handlers stay as they are.\n",
    },
    {
      path: "api-contract.md",
      revision: 1,
      source: "publish",
      at: day("18:58"),
      by: "api",
      description: "Request and response shapes of the v2 orders endpoints",
      readWhen: "Before you call the v2 API",
      appliesTo: ["ui", "integrate"],
      bytes: 3_980,
      contents:
        "# v2 orders API\n\n`POST /v2/orders` creates an order; a repeated idempotency key returns the first order.\n",
    },
    {
      path: "glossary.md",
      revision: 1,
      source: "launch",
      at: day("18:10"),
      description: "Checkout terms as the product uses them",
      bytes: 1_204,
      contents:
        "# Glossary\n\n- **Order**: a confirmed basket.\n- **Payment method**: a saved card or wallet.\n",
    },
  ],
  charter: {
    ...launchCharter,
    revision: 2,
    source: "amend",
    at: day("19:20"),
    reason: "Clarify the final assembled-journey check for integration.",
    mission:
      "Ship checkout v2 behind the checkout-v2 flag without changing the v1 API.",
    invariants: [
      {
        id: "keep-v1-api",
        statement:
          "v1 handlers, routes and response shapes stay byte-for-byte as they are.",
      },
      {
        id: "no-internal-mocks",
        statement: "Tests never vi.mock internal modules.",
      },
      {
        id: "no-table-locks",
        statement: "No migration statement holds a table lock longer than 1s.",
        appliesTo: ["migrate"],
      },
      {
        id: "assembled-journey",
        statement:
          "Verify the complete payment-to-confirmation journey after both lanes publish.",
        appliesTo: ["integrate"],
      },
    ],
    sources: [
      {
        rank: 1,
        label: "Checkout v2 spec",
        locator: "specs/checkout-v2.md",
        description: "Behaviour and copy the release must match",
      },
      {
        rank: 2,
        label: "Payments design",
        locator: "docs/design/payments.md",
        description: "Service boundaries and the flag rollout",
      },
      {
        rank: 3,
        label: "Current checkout",
        locator: "src/checkout/",
        description: "How v1 works today",
      },
    ],
    nonGoals: ["Multi-currency pricing", "Saved-cart sync across devices"],
  },
  activity: [
    {
      id: "event-7",
      seq: 7,
      at: day("19:48"),
      kind: "approval",
      summary: "ui awaits your approval after 2 review rounds",
      contextKey: "ui",
    },
    {
      id: "event-6",
      seq: 6,
      at: day("19:24"),
      kind: "published",
      summary: "lane api published a41c9e0 to the session branch",
    },
    {
      id: "event-5",
      seq: 5,
      at: day("19:22"),
      kind: "succeeded",
      summary: "api succeeded",
      contextKey: "api",
    },
    {
      id: "event-4",
      seq: 4,
      at: day("18:32"),
      kind: "amended",
      summary:
        "The owner retained the accepted rollout plan as plan.md revision 2",
    },
    {
      id: "event-3",
      seq: 3,
      at: day("18:31"),
      kind: "succeeded",
      summary: "plan returned the rollout plan",
      contextKey: "plan",
    },
    {
      id: "event-2",
      seq: 2,
      at: day("18:14"),
      kind: "launched",
      summary: "Launched by Release readiness review",
    },
  ],
  definition: {
    ...launchedDefinition,
    title: "Checkout v2 rollout",
    documents: [
      { path: "plan.md", revision: 2, description: "The rollout plan" },
      { path: "api-contract.md", revision: 1, description: "v2 orders API" },
      { path: "glossary.md", revision: 1, description: "Checkout terms" },
    ],
  },
};

/** An earlier pass keeps its evidence, without passes of its own. */
function passOf(context: ContextDetail): ContextInvocation {
  const { previousInvocations: _passes, ...pass } = context;
  return pass;
}

function completed(context: ContextDetail, at: string): ContextDetail {
  return {
    ...context,
    invocationId: context.invocationId ?? `checkout-${context.key}-1`,
    state: { kind: "succeeded", at },
    tasks: { done: context.taskList.length, total: context.taskList.length },
    taskList: context.taskList.map((task) => ({ ...task, done: true })),
    stages: allDone(context.humanApproval),
    approval: null,
    questions: [],
    reviews: context.reviews.map((round) =>
      round.outcome === "running"
        ? {
            ...round,
            outcome: "passed",
            checks: round.checks.map((check) =>
              check.status === "running"
                ? { ...check, status: "passed" }
                : check,
            ),
            seats: round.seats.map((seat) =>
              seat.status === "pending" ? { ...seat, status: "pass" } : seat,
            ),
          }
        : round,
    ),
    output:
      context.output === null
        ? { status: "accepted", value: { summary: "Completed the contract." } }
        : { ...context.output, status: "accepted" },
    agents: context.agents.map((agent) => ({ ...agent, status: "finished" })),
  };
}

const publishedLanes = checkoutRun.lanes.map((lane) => ({
  ...lane,
  state: "published" as const,
  attempt: 1,
  commit: lane.commit ?? "7d02be4",
}));
const acceptedUi = completed(ui, day("19:51"));

/** Both lanes have published. Session migration can now run and halt. */
export const checkoutHaltedRun: RunDetail = {
  ...checkoutRun,
  contexts: [
    plan,
    api,
    migrate,
    acceptedUi,
    waitingPolish,
    {
      ...integrate,
      state: {
        kind: "waiting",
        dependencies: ["migrate", "polish"],
        provisionLanes: [],
        publicationLanes: [],
      },
    },
    docs,
  ],
  lanes: publishedLanes,
  costUsd: checkoutRun.costUsd + (migrate.costUsd ?? 0),
  attention: [
    {
      kind: "halt",
      contextKey: "migrate",
      contextTitle: migrate.title,
      halt: "turn_failed",
      detail: "Codex stream closed before the turn finished.",
      at: day("20:06"),
    },
  ],
  activity: [
    {
      id: "event-10",
      seq: 10,
      at: day("20:06"),
      kind: "halted",
      summary: "migrate halted: turn failed",
      contextKey: "migrate",
    },
    {
      id: "event-9",
      seq: 9,
      at: day("19:54"),
      kind: "started",
      summary: "migrate started after both lanes published",
      contextKey: "migrate",
    },
    {
      id: "event-8",
      seq: 8,
      at: day("19:53"),
      kind: "published",
      summary: "lane ui published 7d02be4 to the session branch",
    },
    ...checkoutRun.activity,
  ],
};

/** Migration succeeded; the second copy pass is now under review. */
export const checkoutLoopRun: RunDetail = {
  ...checkoutHaltedRun,
  status: { kind: "running" },
  contexts: [
    plan,
    api,
    completed(migrate, day("20:15")),
    acceptedUi,
    { ...polish, previousInvocations: [polishFirstPass] },
    {
      ...integrate,
      state: {
        kind: "waiting",
        dependencies: ["polish"],
        provisionLanes: [],
        publicationLanes: [],
      },
    },
    docs,
  ],
  attention: [],
  costUsd:
    checkoutHaltedRun.costUsd +
    (polish.costUsd ?? 0) +
    (polishFirstPass.costUsd ?? 0),
  loops: checkoutRun.loops.map((loop) => ({
    ...loop,
    pass: 2,
    state: "running",
  })),
  activity: [
    {
      id: "event-14",
      seq: 14,
      at: day("20:52"),
      kind: "started",
      summary: "polish pass 2 started its review",
      contextKey: "polish",
    },
    {
      id: "event-13",
      seq: 13,
      at: day("20:39"),
      kind: "started",
      summary: "polish pass 2 started",
      contextKey: "polish",
    },
    {
      id: "event-12",
      seq: 12,
      at: day("20:38"),
      kind: "succeeded",
      summary: "polish pass 1 finished with more copy work identified",
      contextKey: "polish",
    },
    {
      id: "event-11",
      seq: 11,
      at: day("20:15"),
      kind: "succeeded",
      summary: "migrate succeeded",
      contextKey: "migrate",
    },
    ...checkoutHaltedRun.activity,
  ],
};

export const checkoutSucceededRun: RunDetail = {
  ...checkoutLoopRun,
  status: { kind: "succeeded" },
  finishedAt: day("21:12"),
  attention: [],
  contexts: checkoutLoopRun.contexts.map((context) =>
    context.state.kind === "skipped"
      ? context
      : {
          ...completed(context, day("21:10")),
          startedAt: context.startedAt ?? day("21:02"),
          costUsd: context.costUsd ?? 0.6,
          froze: context.froze ?? {
            charter: 2,
            documents: [{ path: "plan.md", revision: 2, later: null }],
          },
          loop: context.loop === null ? null : { ...context.loop, pass: 3 },
          ...(context.key === "polish"
            ? {
                invocationId: "checkout-polish-3",
                previousInvocations: [
                  passOf(completed(context, day("20:58"))),
                  ...context.previousInvocations,
                ],
                output: {
                  status: "accepted" as const,
                  value: { approved: true, changes: 0 },
                },
              }
            : {}),
        },
  ),
  loops: checkoutLoopRun.loops.map((loop) => ({
    ...loop,
    state: "succeeded",
    pass: 3,
  })),
  activity: [
    {
      id: "event-15",
      seq: 15,
      at: day("21:12"),
      kind: "succeeded",
      summary: "The checkout rollout completed",
    },
    ...checkoutLoopRun.activity,
  ],
};

const noticeImplementer: SeatSummary = {
  assignment: "implementer",
  role: "implementer",
  backend: "claude",
  model: "Opus 5.5",
  effort: "medium",
};

const noticeContext: ContextDetail = {
  decisions: [],
  costComplete: true,
  configuration: configuration({
    documentPublishing: false,
    scope: { mode: "owned", paths: ["src/lib/runs", "src/features/runs"] },
  }),
  previousInvocations: [],
  invocationId: "checkout-agent-1",
  questions: [],
  candidate: null,
  key: "agent",
  title: "Fix the duplicate failure notice",
  placement: { kind: "session" },
  loop: null,
  dependsOn: [],
  state: { kind: "running", step: { kind: "work", reason: "initial" } },
  tasks: { done: 1, total: 3 },
  costUsd: 0.64,
  implementer: noticeImplementer,
  reviewers: [sol("Correctness")],
  humanApproval: false,
  startedAt: day("19:44"),
  brief:
    "The failure notice appears twice when a run halts during review. Find why and make it appear once.",
  taskList: [
    { id: "t1", title: "Reproduce the duplicate", done: true },
    { id: "t2", title: "Fix the cause", done: false },
    { id: "t3", title: "Regression test", done: false },
  ],
  criteria: [
    { id: "ac-1", text: "A halted run produces exactly one failure notice" },
  ],
  stages: stages(
    { workspace: { state: "done" }, work: { state: "current" } },
    false,
  ),
  reviews: [],
  output: null,
  inputs: [],
  agents: [
    {
      conversationId: "c-6a7b8c9d-notice-impl",
      assignment: "implementer",
      seat: noticeImplementer,
      status: "active",
      turns: 1,
      costUsd: 0.64,
    },
  ],
  froze: { charter: null, documents: [] },
  approval: null,
  lastSummary: null,
};

export const noticeRun: RunDetail = {
  runId: "run-3e9d1b70-2c4a-4f8e-9b15-6d0a8c7e4f21",
  title: "Fix the duplicate failure notice",
  kind: "agent",
  status: { kind: "running" },
  owner,
  costComplete: true,
  origin: null,
  definitionRevision: 1,
  startedAt: day("19:44"),
  finishedAt: null,
  costUsd: 0.64,
  attention: [],
  contexts: [noticeContext],
  edges: [],
  lanes: [],
  loops: [],
  documents: [],
  documentHistory: [],
  charter: null,
  charterHistory: [],
  activity: [
    {
      id: "event-2",
      seq: 2,
      at: day("19:44"),
      kind: "started",
      summary: "agent started",
      contextKey: "agent",
    },
    {
      id: "event-1",
      seq: 1,
      at: day("19:44"),
      kind: "launched",
      summary: "Launched by Release readiness review",
    },
  ],
  definition: null,
};

/** The agent run once its result waits for the person's approval. */
export const noticeRunAwaitingApproval: RunDetail = {
  ...noticeRun,
  status: { kind: "needs_input" },
  costUsd: 2.18,
  attention: [
    {
      kind: "approval",
      contextKey: "agent",
      contextTitle: "Fix the duplicate failure notice",
      requestedAt: day("20:02"),
      reviewersPassed: 1,
    },
  ],
  contexts: [
    {
      ...noticeContext,
      humanApproval: true,
      state: { kind: "awaiting_approval", requestedAt: day("20:02") },
      tasks: { done: 3, total: 3 },
      costUsd: 2.18,
      taskList: noticeContext.taskList.map((task) => ({ ...task, done: true })),
      stages: stages(
        {
          workspace: { state: "done" },
          work: { state: "done" },
          output: { state: "done" },
          review: { state: "done", note: "round 1" },
          approval: { state: "waiting" },
        },
        true,
      ),
      reviews: [
        {
          number: 1,
          kind: "full",
          outcome: "passed",
          at: day("19:59"),
          checks: [{ command: "test", status: "passed", durationMs: 96_000 }],
          seats: [
            {
              assignment: "reviewer-1",
              seat: sol("Correctness"),
              status: "pass",
              findings: [],
              advisories: [],
            },
          ],
        },
      ],
      output: {
        status: "candidate",
        value: {
          summary:
            "Run notices are now deduplicated by occurrence; one notice per halt.",
        },
      },
      agents: [
        {
          conversationId: "c-6a7b8c9d-notice-impl",
          assignment: "implementer",
          seat: noticeImplementer,
          status: "idle",
          turns: 2,
          costUsd: 1.6,
        },
        {
          conversationId: "c-0b1c2d3e-notice-rev",
          assignment: "reviewer-1",
          seat: sol("Correctness"),
          status: "finished",
          turns: 1,
          costUsd: 0.58,
        },
      ],
      approval: {
        candidateId: "candidate-notice-1",
        requestedAt: day("20:02"),
      },
      candidate: {
        status: "ready",
        scope: "whole_tree",
        ownedPaths: [],
        diff: {
          totalAdditions: 14,
          totalDeletions: 4,
          files: [
            {
              filePath: "src/lib/runs/notices.ts",
              additions: 9,
              deletions: 4,
              hunks: [
                {
                  header:
                    "@@ -48,7 +48,12 @@ export function noticeFor(boundary: RunBoundary) {",
                  lines: [
                    {
                      type: "hunk-header",
                      content:
                        "@@ -48,7 +48,12 @@ export function noticeFor(boundary: RunBoundary) {",
                    },
                    {
                      type: "remove",
                      content:
                        "  return { key: boundary.seq, text: summary(boundary) };",
                    },
                    {
                      type: "add",
                      content:
                        "  // One notice per occurrence: a halt observed twice is still one halt.",
                    },
                    {
                      type: "add",
                      content:
                        "  return { key: boundary.occurrence, text: summary(boundary) };",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      lastSummary:
        "Notices are keyed by occurrence now; added a regression test for a halt seen twice.",
    },
  ],
};

export const sessionRuns: RunSummary[] = [
  {
    runId: checkoutRun.runId,
    title: checkoutRun.title,
    kind: "workflow",
    status: checkoutRun.status,
    attention: checkoutRun.attention.length,
    contexts: { done: 2, total: 6 },
    costUsd: checkoutRun.costUsd,
    costComplete: true,
    startedAt: checkoutRun.startedAt,
    finishedAt: null,
    owner,
  },
  {
    runId: noticeRun.runId,
    title: noticeRun.title,
    kind: "agent",
    status: noticeRun.status,
    attention: 0,
    contexts: { done: 0, total: 1 },
    costUsd: noticeRun.costUsd,
    costComplete: true,
    startedAt: noticeRun.startedAt,
    finishedAt: null,
    owner,
  },
  {
    runId: "run-5a6b7c8d-1e2f-4a3b-9c8d-7e6f5a4b3c2d",
    title: "Refresh the docs index",
    kind: "agent",
    status: { kind: "succeeded" },
    attention: 0,
    contexts: { done: 1, total: 1 },
    costUsd: 0.92,
    costComplete: true,
    startedAt: day("16:02"),
    finishedAt: day("16:19"),
    owner,
  },
  {
    runId: "run-9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
    title: "Lane merge timing spike",
    kind: "workflow",
    status: { kind: "cancelled" },
    attention: 0,
    contexts: { done: 1, total: 4 },
    costUsd: 3.37,
    costComplete: true,
    startedAt: day("14:40"),
    finishedAt: day("15:12"),
    owner: {
      conversationId: "c-11aa22bb-spike-owner",
      title: "Lane merge investigation",
      backend: "codex",
    },
  },
];
