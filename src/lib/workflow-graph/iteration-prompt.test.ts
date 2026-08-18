import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildIterationPrompt as buildIterationPromptWithValidation,
  buildFollowUpPrompt,
  type BuildIterationPromptInput,
} from "./iteration-prompt";
import {
  formatQuestionAnswersBlock,
  splitQuestionAnswersBlock,
} from "@/lib/conversations/question-answers-block";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowCollaborationContinuation } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";
import { makeProfileSnapshot } from "./test-fixtures";
import type { ValidationPromptSelections } from "./validation-prompt-section";

const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

type TestBuildIterationPromptInput = Omit<
  BuildIterationPromptInput,
  "validationSelections"
> & {
  validationSelections?: ValidationPromptSelections;
};

function buildIterationPrompt(input: TestBuildIterationPromptInput): string {
  return buildIterationPromptWithValidation({
    ...input,
    validationSelections:
      input.validationSelections ?? EMPTY_VALIDATION_SELECTIONS,
  });
}

function makeCharter(
  overrides: Partial<WorkflowCharter> = {},
): WorkflowCharter {
  return {
    mission: "Ship the billing rewrite without breaking existing invoices.",
    sourcesOfTruth: [
      {
        rank: 1,
        id: "domain-spec",
        label: "Billing domain spec",
        type: "spec",
        locator: "docs/billing-spec.md",
        description: "Authoritative invoice lifecycle rules.",
        appliesTo: "billing/**",
        accessPolicy: "worktree-relative",
      },
      {
        rank: 2,
        id: "legacy-ledger",
        label: "Legacy ledger schema",
        type: "code",
        locator: "https://internal.example/ledger",
        description: "Read-only reference for historical ledger columns.",
        accessPolicy: "external-readonly",
      },
    ],
    ...overrides,
  };
}
function makeContext(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    placement: { lane: "context-plan", mode: "full" as const },
    id: "context-plan",
    title: "Plan",
    description: "Plan the implementation",
    acceptanceCriteria: "Planning complete.",
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<GraphWorkflowTaskDefinition> = {},
): GraphWorkflowTaskDefinition {
  return {
    id: "task-plan-1",
    contextId: "context-plan",
    order: 1,
    title: "Inspect code",
    instructions: "Read the relevant files.",
    source: "user" as const,
    ...overrides,
  };
}

function makeSharedDoc(
  overrides: Partial<GraphWorkflowSharedDocumentEntry> = {},
): GraphWorkflowSharedDocumentEntry {
  return {
    id: "doc-1",
    relativePath: "memory-bank/shared/plan.md",
    description: "Current implementation plan",
    readWhen: "Read before starting implementation tasks.",
    kind: "shared",
    createdAt: "2026-03-27T15:00:00.000Z",
    updatedAt: "2026-03-27T15:00:00.000Z",
    lastUpdatedByConversationId: "conversation-seed",
    ...overrides,
  };
}

function makeTaskState(
  overrides: Partial<GraphWorkflowTaskState> = {},
): GraphWorkflowTaskState {
  return {
    taskId: "task-plan-1",
    contextId: "context-plan",
    order: 1,
    status: "pending",
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

function makeLatestContextValidationFailure() {
  return {
    summary: "Validation failed because rollback notes are missing.",
    reopenedTasks: [
      { taskId: "task-plan-2", title: "Write plan" },
      { taskId: "task-plan-3", title: "Add rollout checklist" },
    ],
    groupedIssues: [
      {
        heading: "Task `task-plan-2` - Write plan",
        issues: [
          {
            title: "Missing rollback notes",
            description: "Add rollback guidance to the plan.",
          },
        ],
      },
      {
        heading: "General Issues",
        issues: [
          {
            title: "Incomplete validation",
            description: "Verify the rollout checklist against the runbook.",
          },
        ],
      },
    ],
  };
}

describe("buildIterationPrompt", () => {
  it("requires resolved validation selections", () => {
    expectTypeOf<
      BuildIterationPromptInput["validationSelections"]
    >().toEqualTypeOf<ValidationPromptSelections>();
  });

  it("includes execution context title and goal", () => {
    const prompt = buildIterationPrompt({
      context: makeContext({
        title: "Implement",
        description: "Build the feature",
      }),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Implement");
    expect(prompt).toContain("Build the feature");
  });

  it("renders the validation commands section from the provided selections", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      validationSelections: {
        registry: "loaded",
        enabled: {
          kind: "commands",
          commands: [
            { name: "typecheck", cost: 2 },
            { name: "test", cost: 4 },
          ],
        },
        disabled: ["format"],
        scriptGate: { kind: "commands", commands: ["typecheck", "test"] },
      },
    });

    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain("`cctl validate run <name>`");
    expect(prompt).toContain(
      "Enabled for you in this context: typecheck (cost 2), test (cost 4).",
    );
    expect(prompt).toContain("Disabled for you in this context: format.");
    expect(prompt).toContain(
      "Script gate for this context (runs separately when the context completes): typecheck, test.",
    );
    expect(prompt).toContain(
      "If a run is refused for capacity, continue other work and retry later, or re-run with `--wait` to queue for a slot.",
    );
  });

  it("renders the validation section for an empty registry and frozen script gate", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      validationSelections: {
        registry: "none",
        enabled: { kind: "commands", commands: [] },
        disabled: [],
        scriptGate: { kind: "commands", commands: ["typecheck"] },
      },
    });

    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain(
      "No validation commands are enabled for you in this context.",
    );
    expect(prompt).toContain(
      "Script gate for this context (runs separately when the context completes): typecheck.",
    );
  });

  it("renders explicit empty validation state", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      validationSelections: {
        registry: "none",
        enabled: { kind: "commands", commands: [] },
        disabled: [],
        scriptGate: { kind: "off" },
      },
    });

    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain(
      "No validation commands are enabled for you in this context.",
    );
    expect(prompt).toContain("No script gate is selected for this context.");
  });

  it("instructs the exact `cctl workflow task complete` invocation with taskId and summary", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("begin_task");
    expect(prompt).toContain("cctl workflow task complete");
    expect(prompt).toContain("<taskId>");
    expect(prompt).toContain("--summary");
    // The migration removes MCP tool names from the lane's only discovery surface.
    expect(prompt).not.toContain("mcp__");
    expect(prompt).not.toContain("complete_task");
  });

  it("renders the previous conversation's handoff verbatim when rotation carried one", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      previousConversationHandoff: {
        conversationId: "conv-prev-1",
        note: "Completed task-plan-1. Left in flight: nothing. Lesson: the dev server on :3071 needs an explicit CC_SERVER_URL.",
      },
    });

    expect(prompt).toContain("## Handoff from the previous conversation");
    expect(prompt).toContain("reached its context limit and was rotated out");
    expect(prompt).toContain(
      "Lesson: the dev server on :3071 needs an explicit CC_SERVER_URL.",
    );
    // The handoff must precede the task list so orientation happens before work.
    expect(
      prompt.indexOf("## Handoff from the previous conversation"),
    ).toBeLessThan(prompt.indexOf("## Tasks (work through them in order)"));
  });

  it("omits the handoff section when no previous-conversation handoff exists", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("## Handoff from the previous conversation");
  });

  it("primes the Required Protocol to end the turn on a CONTEXT LIMIT REACHED stop instruction", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    const protocol = prompt.slice(prompt.indexOf("## Required Protocol"));
    expect(protocol).toContain(
      "If `cctl workflow task complete` prints a stop instruction (CONTEXT LIMIT REACHED …), end your turn immediately — do not begin another task. The workflow continues the remaining tasks in a fresh conversation automatically.",
    );
  });

  it("notes on the complete-task command that a printed stop instruction is mandatory", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    const commandRef = prompt.slice(prompt.indexOf("### Complete a task"));
    expect(commandRef).toContain("that is mandatory: stop and end your turn");
  });

  it("documents the `cctl workflow shared-doc upsert` command", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("cctl workflow shared-doc upsert");
  });

  it("directs scratch and --file payloads to git-ignored .cc/temp/ so they are not committed at land time", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    // The scratch-file convention is stated and explains the land-time commit.
    expect(prompt).toContain(".cc/temp/");
    expect(prompt.toLowerCase()).toContain("committed");
    // The shared-doc metadata payload example follows it — no bare-root doc.json
    // that a lane's `git add -A` would sweep into the branch.
    expect(prompt).toContain(".cc/temp/doc.json");
    expect(prompt).not.toContain("--file <doc.json>");
  });

  it("directs session readers to keep cctl payloads in private scratch and documents the live view", () => {
    const prompt = buildIterationPrompt({
      context: makeContext({
        placement: { lane: "session", mode: "readOnly" },
      }),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("per-context scratch directory");
    expect(prompt).toContain("live view");
    expect(prompt).not.toContain(
      "Write scratch and payload files — including the `--file` JSON the commands below read — under `.cc/temp/`",
    );
  });

  it("includes `cctl workflow task add` when allowAgentTaskAdd is true", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: true,
    });

    expect(prompt).toContain("cctl workflow task add");
  });

  it("omits `cctl workflow task add` when allowAgentTaskAdd is false", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("cctl workflow task add");
  });

  it("includes `cctl workflow collab request` with when-to-use guidance when allowAgentCollaboration is true", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      allowAgentCollaboration: true,
    });

    expect(prompt).toContain("cctl workflow collab request");
    expect(prompt).toContain("--brief");
    // Must convey WHEN to reach for it, not just what it does.
    expect(prompt).toMatch(/ambiguous|hard-to-reverse|high-impact|trade-off/i);
  });

  it("omits `cctl workflow collab request` when allowAgentCollaboration is false", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      allowAgentCollaboration: false,
      collaborationContinuations: [makeCollaborationContinuation()],
    });

    expect(prompt.toLowerCase()).not.toContain("collaboration");
  });

  it("omits `cctl workflow collab request` when allowAgentCollaboration is omitted", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("cctl workflow collab request");
  });

  it("instructs the agent to work through tasks in order", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [
        makeTask({ id: "task-1", title: "First task" }),
        makeTask({ id: "task-2", order: 2, title: "Second task" }),
      ],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    // Should instruct sequential processing, not single-task focus
    expect(prompt).toMatch(
      /work.+through.+tasks.+in.+order|take.+tasks.+in.+order|work.+through.+them/i,
    );
    expect(prompt).toContain("cctl workflow task complete");
  });

  it("warns about the consequences of not completing tasks", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toMatch(
      /do not run `cctl workflow task complete`|blocks all workflow progress|workflow will stall/i,
    );
  });

  it("lists remaining tasks with their status and instructions", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [
        makeTask({
          id: "task-1",
          title: "Inspect code",
          instructions: "Read files.",
        }),
        makeTask({
          id: "task-2",
          order: 2,
          title: "Write plan",
          instructions: "Document plan.",
        }),
      ],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
        "task-2": makeTaskState({ taskId: "task-2", order: 2 }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Inspect code");
    expect(prompt).toContain("Write plan");
    expect(prompt).toContain("Read files.");
    expect(prompt).toContain("Document plan.");
    expect(prompt).toContain("pending");
  });

  it("lists shared documents when present", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [
        makeSharedDoc({
          relativePath: "docs/api-contract.md",
          description: "API contract",
          readWhen: "Before implementing routes.",
        }),
      ],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("docs/api-contract.md");
    expect(prompt).toContain("API contract");
    expect(prompt).toContain("Before implementing routes.");
  });

  it("renders full failure history when multiple validation failures exist", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({
          taskId: "task-1",
          status: "interrupted",
          startedAt: "2026-03-27T16:00:00.000Z",
          failureHistory: [
            {
              message: "Missing test coverage for edge cases.",
              timestamp: "2026-03-27T16:05:00.000Z",
            },
            {
              message: "Tests still do not exercise the service path.",
              timestamp: "2026-03-27T16:15:00.000Z",
            },
          ],
        }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Attempt 1");
    expect(prompt).toContain("Missing test coverage for edge cases.");
    expect(prompt).toContain("Attempt 2");
    expect(prompt).toContain("Tests still do not exercise the service path.");
  });

  it("falls back to failureMessage when failureHistory is empty", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({
          taskId: "task-1",
          status: "interrupted",
          startedAt: "2026-03-27T16:00:00.000Z",
          failureMessage:
            "Task validation blocked completion.\n- Missing test coverage: Add unit tests for the new parser.",
          failureHistory: [],
        }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).toContain("Missing test coverage");
    expect(prompt).toContain("Add unit tests for the new parser");
  });

  it("does not include failure feedback section when no failures exist", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toMatch(
      /previous.+attempt|validation.+failure|failure.+history/i,
    );
  });

  it("does not have a single active task concept", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [
        makeTask({ id: "task-1", title: "First task" }),
        makeTask({ id: "task-2", order: 2, title: "Second task" }),
      ],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    // Should not mark any single task as "active" — the agent works through all of them
    expect(prompt).not.toMatch(/\(active task\)/i);
    expect(prompt).not.toContain("Your Active Task");
  });

  it("includes acceptance criteria when contextValidationAcceptanceCriteria is provided", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      contextValidationAcceptanceCriteria:
        "Verify test coverage exists and all tests pass.",
    });

    expect(prompt).toContain("Acceptance Criteria");
    expect(prompt).toContain("Verify test coverage exists and all tests pass.");
  });

  it("omits validation criteria section when no instructions provided", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("Validation Criteria");
  });

  it("begins with the charter digest and points to the full charter document", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: makeCharter(),
    });

    expect(prompt.startsWith("# Workflow Charter")).toBe(true);
    // The digest renders mission + ranked hierarchy before the execution context.
    expect(prompt.indexOf("# Workflow Charter")).toBeLessThan(
      prompt.indexOf("# Execution Context"),
    );
    expect(prompt).toContain(
      "Ship the billing rewrite without breaking existing invoices.",
    );
    expect(prompt).toContain(".cc/graph-workflow-docs/charter.md");
  });

  it("instructs the implementer to verify charter invariants before completing tasks", () => {
    // Audit 1beec403: 2 of 4 NO-GOs were charter type-escape violations in
    // NEW test code — once from faithfully mirroring an exemplar that itself
    // violated the invariant. Validators already get an explicit per-invariant
    // check instruction; the implementer needs the obligation up front.
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: makeCharter({
        invariants: [
          {
            id: "no-type-escapes",
            statement: "New code must not use `as unknown` or `@ts-ignore`.",
          },
        ],
      }),
    });

    expect(prompt).toContain("Verify every applicable charter invariant");
    expect(prompt).toContain("concrete check");
    expect(prompt).toContain("mirror");
  });

  it("omits the invariant-check instruction when the charter declares none", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: makeCharter({ invariants: [] }),
    });

    expect(prompt).not.toContain("Verify every applicable charter invariant");
  });

  it("renders no amendment log, access-policy, or precedence text in the charter section", () => {
    // The prompt diet (change 3): agents read the current rules; amendment
    // history, access bookkeeping, and the retired precedence/deferral rule
    // live only in charter.md and the durable record.
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: makeCharter(),
    });

    expect(prompt).not.toContain("Amendment log");
    expect(prompt).not.toContain("Access:");
    expect(prompt.toLowerCase()).not.toContain("higher-ranked source");
    expect(prompt).not.toContain("Applying the source-of-truth hierarchy");
  });

  it("renders only global sources plus sources scoped to the rendering context", () => {
    const scopedCharter = makeCharter({
      sourcesOfTruth: [
        {
          rank: 1,
          id: "domain-spec",
          label: "Billing domain spec",
          type: "spec",
          locator: "docs/billing-spec.md",
          description: "Authoritative invoice lifecycle rules.",
        },
        {
          rank: 2,
          id: "plan-notes",
          label: "Planning notes",
          type: "document",
          locator: "docs/plan-notes.md",
          description: "Notes that only concern the planning context.",
          appliesTo: { contextIds: ["context-plan"] },
        },
      ],
    });

    const inScope = buildIterationPrompt({
      context: makeContext({ id: "context-plan" }),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: scopedCharter,
    });
    const outOfScope = buildIterationPrompt({
      context: makeContext({ id: "context-integrate" }),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: scopedCharter,
    });

    expect(inScope).toContain("Planning notes");
    expect(outOfScope).not.toContain("Planning notes");
    expect(inScope).toContain("Billing domain spec");
    expect(outOfScope).toContain("Billing domain spec");
  });

  it("renders the charter section under charterContextId when it differs from the runtime context id", () => {
    // A loop-instance iteration runs under an expanded id like
    // `group__p2__context-plan`; scoped sources bind the authored id, which the
    // orchestrator passes as charterContextId.
    const prompt = buildIterationPrompt({
      context: makeContext({ id: "group__p2__context-plan" }),
      charterContextId: "context-plan",
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: makeCharter({
        sourcesOfTruth: [
          {
            rank: 1,
            id: "plan-notes",
            label: "Planning notes",
            type: "document",
            locator: "docs/plan-notes.md",
            description: "Notes that only concern the planning context.",
            appliesTo: { contextIds: ["context-plan"] },
          },
        ],
      }),
    });

    expect(prompt).toContain("Planning notes");
  });

  it("tells a continuation turn how many times the charter was amended", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask()],
      taskStates: {},
      attemptNumber: 2,
      maxAttempts: 5,
      charter: makeCharter(),
      charterAmendments: [
        {
          seq: 1,
          amendedAt: "2026-07-29T10:00:00.000Z",
          source: "cli",
          rationale: "Mission narrowed",
          fieldsChanged: ["mission"],
          charterHash: "hash-1",
        },
      ],
    });

    expect(prompt).toMatch(/amended 1 time/i);
    expect(prompt).toContain(".cc/graph-workflow-docs/charter.md");
  });

  it("instructs the implementer to cite the governing source without any access-policy instruction", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      charter: makeCharter(),
    });

    // 5.4: cite the governing source in the completion summary on conflict.
    expect(prompt).toMatch(/cite.+governing source/i);
    expect(prompt).toMatch(/cctl workflow task complete/);
    // Access policy retired (change 3): external material is materialized at
    // plan time, so no per-agent permission rule ships in the prompt.
    expect(prompt).not.toContain("outside the worktree are read-only");
  });

  it("excludes the charter entry from the generic Shared Documents list", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [
        makeSharedDoc({
          id: "doc-charter",
          relativePath: ".cc/graph-workflow-docs/charter.md",
          description: "The workflow charter document",
          readWhen: "Read for source-of-truth precedence.",
          kind: "charter",
        }),
        makeSharedDoc({
          id: "doc-plan",
          relativePath: "memory-bank/shared/plan.md",
          description: "Current implementation plan",
          readWhen: "Read before starting implementation tasks.",
          kind: "shared",
        }),
      ],
      allowAgentTaskAdd: false,
      charter: makeCharter(),
    });

    const sharedSection = prompt.slice(prompt.indexOf("## Shared Documents"));
    expect(sharedSection).toContain("memory-bank/shared/plan.md");
    expect(sharedSection).not.toContain("The workflow charter document");
  });

  it("marks an engine-seeded document read-only so an agent does not edit a file the next materialization overwrites", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [
        makeSharedDoc({
          id: "doc-spec",
          relativePath: ".cc/graph-workflow-docs/spec/native-sdd.md",
          description: "The pinned spec this run implements",
          readWhen: "Read before judging the work.",
          kind: "seeded",
        }),
        makeSharedDoc({
          id: "doc-plan",
          relativePath: "memory-bank/shared/plan.md",
          description: "Current implementation plan",
          readWhen: "Read before starting implementation tasks.",
          kind: "shared",
        }),
      ],
      allowAgentTaskAdd: false,
      charter: makeCharter(),
    });

    const sharedSection = prompt.slice(prompt.indexOf("## Shared Documents"));
    expect(sharedSection).toContain(
      ".cc/graph-workflow-docs/spec/native-sdd.md",
    );
    expect(sharedSection).toMatch(
      /native-sdd\.md.*\(read-only: engine-owned\)/,
    );
    // Agent-authored documents stay writable and carry no such marker.
    expect(sharedSection).toMatch(/plan\.md.*implementation tasks\.$/m);
  });

  it("renders 'None registered' in the generic list when only the charter entry exists", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [
        makeSharedDoc({
          id: "doc-charter",
          relativePath: ".cc/graph-workflow-docs/charter.md",
          description: "The workflow charter document",
          readWhen: "Read for source-of-truth precedence.",
          kind: "charter",
        }),
      ],
      allowAgentTaskAdd: false,
      charter: makeCharter(),
    });

    const sharedSection = prompt.slice(prompt.indexOf("## Shared Documents"));
    expect(sharedSection).toContain("- None registered.");
  });

  it("omits the charter section when no charter is provided", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(prompt).not.toContain("# Workflow Charter");
    expect(prompt.startsWith("# Execution Context")).toBe(true);
  });

  it("includes the latest failed context validation summary, reopened tasks, and grouped issues", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      latestContextValidationFailure: makeLatestContextValidationFailure(),
    });

    expect(prompt).toContain("Latest Context Validation Failure");
    expect(prompt).toContain(
      "Validation failed because rollback notes are missing.",
    );
    expect(prompt).toContain("`task-plan-2` - Write plan");
    expect(prompt).toContain("Task `task-plan-2` - Write plan");
    expect(prompt).toContain("Missing rollback notes");
    expect(prompt).toContain("General Issues");
  });

  it("names no MCP tools anywhere across the full input surface (doc 02 §4.3)", () => {
    // The lane prompt is the lane agent's ONLY discovery surface, so the CLI
    // migration must leave zero MCP tool references in it. Render the maximal
    // surface — every optional tool section (task add, collaboration) plus
    // failure history, acceptance criteria, and shared docs — and assert the
    // legacy tool names and any `mcp__` gateway id are gone, replaced by the
    // exact `cctl workflow …` invocations.
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask({ id: "task-1" }), makeTask({ id: "task-2", order: 2 })],
      taskStates: {
        "task-1": makeTaskState({
          taskId: "task-1",
          status: "interrupted",
          failureHistory: [
            { message: "prior failure", timestamp: "2026-03-27T16:05:00.000Z" },
          ],
        }),
      },
      sharedDocuments: [makeSharedDoc()],
      allowAgentTaskAdd: true,
      allowAgentCollaboration: true,
      contextValidationAcceptanceCriteria: "All tasks complete.",
      latestContextValidationFailure: makeLatestContextValidationFailure(),
      charter: makeCharter(),
    });

    for (const name of [
      "mcp__",
      "complete_task",
      "add_task",
      "upsert_shared_document",
      "request_collaboration",
    ]) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).toContain("cctl workflow task complete");
    expect(prompt).toContain("cctl workflow task add");
    expect(prompt).toContain("cctl workflow shared-doc upsert");
    expect(prompt).toContain("cctl workflow collab request");
  });

  it("buildFollowUpPrompt names no MCP tools and instructs the cctl completion verb", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: { "task-1": makeTaskState({ taskId: "task-1" }) },
      attemptNumber: 1,
      maxAttempts: 2,
      latestContextValidationFailure: makeLatestContextValidationFailure(),
      charter: makeCharter(),
    });

    for (const name of [
      "mcp__",
      "complete_task",
      "add_task",
      "upsert_shared_document",
      "request_collaboration",
    ]) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).toContain("cctl workflow task complete");
  });

  describe("upstream structured inputs (D2 R5.1)", () => {
    const planInput: GraphWorkflowUpstreamInput = {
      skipped: false,
      contextId: "context-plan",
      title: "Plan",
      declared: true,
      schemaFields: [
        {
          name: "summary",
          type: "string",
          required: true,
          description: "One-line plan summary",
        },
        { name: "risks", type: "array", required: true, description: null },
      ],
      output: {
        summary: "Migrate the store first",
        risks: ["schema drift"],
      },
    };

    it("renders each upstream output as schema-conformant JSON before the context's own brief", () => {
      const prompt = buildIterationPrompt({
        context: makeContext(),
        tasks: [makeTask()],
        taskStates: {},
        sharedDocuments: [],
        allowAgentTaskAdd: false,
        upstreamInputs: [planInput],
      });

      expect(prompt).toContain("## Inputs from upstream");
      expect(prompt).toContain("### context-plan — Plan");
      // The payload must round-trip as JSON: the downstream agent is told to
      // treat it as data, so a prose paraphrase would break the contract.
      const fenced = prompt.split("```json")[1]?.split("```")[0] ?? "";
      expect(JSON.parse(fenced)).toEqual(planInput.output);
      // Before the brief: inputs are read first, like a function's arguments.
      expect(prompt.indexOf("## Inputs from upstream")).toBeLessThan(
        prompt.indexOf("## Tasks (work through them in order)"),
      );
    });

    it("names the declared fields so the agent can address the payload", () => {
      const prompt = buildIterationPrompt({
        context: makeContext(),
        tasks: [makeTask()],
        taskStates: {},
        sharedDocuments: [],
        allowAgentTaskAdd: false,
        upstreamInputs: [planInput],
      });

      expect(prompt).toContain("summary");
      expect(prompt).toContain("One-line plan summary");
    });

    it("renders no section when no upstream produced an output", () => {
      const pendingUpstream: GraphWorkflowUpstreamInput = {
        skipped: false,
        contextId: "context-plan",
        title: "Plan",
        declared: true,
        schemaFields: planInput.schemaFields,
        output: null,
      };
      const freeFormUpstream: GraphWorkflowUpstreamInput = {
        skipped: false,
        contextId: "context-design",
        title: "Design",
        declared: false,
        schemaFields: null,
        output: null,
      };

      for (const upstreamInputs of [
        undefined,
        [],
        [pendingUpstream],
        [freeFormUpstream, pendingUpstream],
      ]) {
        const prompt = buildIterationPrompt({
          context: makeContext(),
          tasks: [makeTask()],
          taskStates: {},
          sharedDocuments: [],
          allowAgentTaskAdd: false,
          ...(upstreamInputs !== undefined ? { upstreamInputs } : {}),
        });

        expect(prompt).not.toContain("## Inputs from upstream");
      }
    });

    it("omits upstreams that produced nothing while rendering the ones that did", () => {
      const prompt = buildIterationPrompt({
        context: makeContext(),
        tasks: [makeTask()],
        taskStates: {},
        sharedDocuments: [],
        allowAgentTaskAdd: false,
        upstreamInputs: [
          {
            skipped: false,
            contextId: "context-design",
            title: "Design",
            declared: false,
            schemaFields: null,
            output: null,
          },
          planInput,
        ],
      });

      expect(prompt).toContain("### context-plan — Plan");
      expect(prompt).not.toContain("### context-design — Design");
    });

    // D4 R4.3: a skipped predecessor is NOT the same absence as one that
    // produced nothing. Dropping it silently leaves the agent to assume the
    // branch is still coming; naming it as not taken is the whole point.
    describe("skipped predecessors (D4 R4.3)", () => {
      const skippedUpstream: GraphWorkflowUpstreamInput = {
        contextId: "context-design",
        title: "Design",
        declared: true,
        schemaFields: planInput.schemaFields,
        output: null,
        skipped: true,
      };

      it("labels a skipped upstream as a branch not taken instead of omitting it", () => {
        const prompt = buildIterationPrompt({
          context: makeContext(),
          tasks: [makeTask()],
          taskStates: {},
          sharedDocuments: [],
          allowAgentTaskAdd: false,
          upstreamInputs: [skippedUpstream, planInput],
        });

        expect(prompt).toContain("### context-design — Design");
        expect(prompt).toContain("branch not taken");
        // No payload block for a branch that never ran.
        expect(prompt.split("```json")).toHaveLength(2);
      });

      it("renders the section for a skipped upstream even when nothing was captured", () => {
        const prompt = buildIterationPrompt({
          context: makeContext(),
          tasks: [makeTask()],
          taskStates: {},
          sharedDocuments: [],
          allowAgentTaskAdd: false,
          upstreamInputs: [skippedUpstream],
        });

        expect(prompt).toContain("## Inputs from upstream");
        expect(prompt).toContain("branch not taken");
      });
    });
  });
});

describe("buildFollowUpPrompt", () => {
  it("lists remaining task details and reminds the agent to continue", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [
        makeTask({
          id: "task-plan-1",
          title: "Inspect code",
          instructions: "Read files.",
        }),
        makeTask({
          id: "task-plan-2",
          order: 2,
          title: "Write plan",
          instructions: "Document plan.",
        }),
      ],
      taskStates: {
        "task-plan-1": makeTaskState({
          taskId: "task-plan-1",
        }),
        "task-plan-2": makeTaskState({
          taskId: "task-plan-2",
          order: 2,
          status: "interrupted",
        }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain("task-plan-1");
    expect(prompt).toContain("task-plan-2");
    expect(prompt).toContain("Inspect code");
    expect(prompt).toContain("Write plan");
    expect(prompt).toContain("Read files.");
    expect(prompt).toContain("Document plan.");
    expect(prompt).toContain("interrupted");
    expect(prompt).toContain("cctl workflow task complete");
  });

  it("includes the attempt number and max attempts", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(prompt).toMatch(/2/);
    expect(prompt).toMatch(/3/);
  });

  it("warns that workflow will stall without tool call", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toMatch(/stall|block|halt|cannot.+progress/i);
  });

  it("includes validation failure feedback for remaining tasks", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "fix-1234", title: "Fix tests" })],
      taskStates: {
        "fix-1234": makeTaskState({
          taskId: "fix-1234",
          failureMessage: "Previous patch missed regression coverage.",
        }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).toContain("Previous Attempt Failed");
    expect(prompt).toContain("Previous patch missed regression coverage.");
  });

  it("carries a compact charter reference on continuation turns without the full digest", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
      charter: makeCharter(),
    });

    expect(prompt).toMatch(/charter/i);
    expect(prompt).toContain(".cc/graph-workflow-docs/charter.md");
    // The reminder is a compact pointer — no precedence rule (retired with
    // plan-time conflict resolution), no ranked hierarchy, no mission.
    expect(prompt).not.toMatch(/higher-ranked source/i);
    expect(prompt).not.toContain("## Mission");
    expect(prompt).not.toContain(
      "Ship the billing rewrite without breaking existing invoices.",
    );
  });

  it("omits the charter reference when no charter is provided", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-1" })],
      taskStates: {
        "task-1": makeTaskState({ taskId: "task-1" }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
    });

    expect(prompt).not.toContain(".cc/graph-workflow-docs/charter.md");
  });

  it("includes latest failed context validation feedback during follow-up prompts", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask({ id: "task-plan-2", title: "Write plan" })],
      taskStates: {
        "task-plan-2": makeTaskState({ taskId: "task-plan-2" }),
      },
      attemptNumber: 1,
      maxAttempts: 2,
      latestContextValidationFailure: makeLatestContextValidationFailure(),
    });

    expect(prompt).toContain("Latest Context Validation Failure");
    expect(prompt).toContain("`task-plan-2` - Write plan");
    expect(prompt).toContain("Missing rollback notes");
  });
});

// Req 6.3: the background-task-handling feature "shall not change the prompts
// shown to the implementer agent." The feature is deliberately driven entirely
// by SDK lifecycle signals and the out-of-band `waitForBackgroundTasks` turn
// option — never by prompt instructions. These tests pin that invariant by
// asserting the rendered implementer prompts contain none of the wait/background
// language the feature introduces elsewhere. They render the maximal input
// surface (failure history, collaboration continuations, acceptance criteria,
// shared documents) so every section is covered, and they would fail if any
// future edit leaked background-task wording into the prompts.
const BACKGROUND_TASK_PROMPT_PHRASES = [
  "background task",
  "background-task",
  "backgroundwait",
  "wait for background",
  "waitforbackgroundtasks",
  "long-lived watch",
  "in-flight background",
  "settlement",
  "wait barrier",
  "in the background",
] as const;

function makeCollaborationContinuation(): GraphWorkflowCollaborationContinuation {
  return {
    workflowId: "collab-workflow-1",
    brief: "Resolve the API ownership question with the platform agent.",
    result: {
      status: "rounds_exhausted",
      finalAnswer: null,
      openConflicts: [
        {
          rejectingAgent: "agent_one",
          disputedPoint: "Endpoint placement remains disputed.",
          severity: "blocking",
          category: "implementation",
        },
      ],
    },
    roundsConsumed: 3,
    completedAt: "2026-03-27T17:00:00.000Z",
    deliveredAt: null,
  };
}

function assertNoBackgroundTaskLanguage(prompt: string): void {
  const lowered = prompt.toLowerCase();
  for (const phrase of BACKGROUND_TASK_PROMPT_PHRASES) {
    expect(lowered).not.toContain(phrase);
  }
}

describe("background-task-handling prompt invariance (Req 6.3)", () => {
  it("buildIterationPrompt renders no background-task or waiting language across the full input surface", () => {
    const prompt = buildIterationPrompt({
      context: makeContext({
        title: "Implement the build pipeline",
        description: "Wire up CI and run the test suite.",
      }),
      tasks: [
        makeTask({
          id: "task-1",
          title: "Run the build",
          instructions: "Compile the project and run the suite.",
        }),
        makeTask({
          id: "task-2",
          order: 2,
          title: "Start the dev server",
          instructions: "Boot the local server and verify it serves requests.",
        }),
      ],
      taskStates: {
        "task-1": makeTaskState({
          taskId: "task-1",
          status: "interrupted",
          failureHistory: [
            {
              message: "The suite did not finish running.",
              timestamp: "2026-03-27T16:05:00.000Z",
            },
          ],
        }),
        "task-2": makeTaskState({ taskId: "task-2", order: 2 }),
      },
      sharedDocuments: [makeSharedDoc()],
      allowAgentTaskAdd: true,
      contextValidationAcceptanceCriteria:
        "All tasks complete and the test suite passes.",
      latestContextValidationFailure: makeLatestContextValidationFailure(),
      collaborationContinuations: [makeCollaborationContinuation()],
    });

    assertNoBackgroundTaskLanguage(prompt);
  });

  it("buildIterationPrompt renders no background-task language in the minimal (no-feedback) shape", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    assertNoBackgroundTaskLanguage(prompt);
  });

  it("buildFollowUpPrompt renders no background-task or waiting language across the full input surface", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [
        makeTask({
          id: "task-plan-2",
          order: 2,
          title: "Write plan",
          instructions: "Document the rollout plan.",
        }),
      ],
      taskStates: {
        "task-plan-2": makeTaskState({
          taskId: "task-plan-2",
          order: 2,
          status: "interrupted",
          failureMessage: "Previous patch missed regression coverage.",
        }),
      },
      attemptNumber: 2,
      maxAttempts: 3,
      latestContextValidationFailure: makeLatestContextValidationFailure(),
      collaborationContinuations: [makeCollaborationContinuation()],
    });

    assertNoBackgroundTaskLanguage(prompt);
  });
});

describe("answer resume delivery", () => {
  const questionBatchId = "batch-plan-1";
  const answers: Record<string, AskQuestionAnswer> = {
    q1: {
      selected: ["Postgres"],
      note: "Prefer managed hosting.",
      skipped: false,
      question: "Which datastore should the billing service use?",
    },
  };

  it("buildFollowUpPrompt embeds the framed answers block (pinned variant)", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask()],
      taskStates: {},
      attemptNumber: 1,
      maxAttempts: 3,
      resumeUserInput: { questionBatchId, answers },
    });

    const split = splitQuestionAnswersBlock(prompt);
    expect(split).not.toBeNull();
    expect(split?.block.questionBatchId).toBe(questionBatchId);
    expect(split?.block.answers).toEqual(answers);
    expect(prompt).toContain(
      formatQuestionAnswersBlock(questionBatchId, answers),
    );
    expect(prompt).toContain("## Your Question Was Answered");
  });

  it("buildIterationPrompt embeds the framed answers block (rotated seed variant)", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      resumeUserInput: { questionBatchId, answers },
    });

    const split = splitQuestionAnswersBlock(prompt);
    expect(split).not.toBeNull();
    expect(split?.block.questionBatchId).toBe(questionBatchId);
    expect(split?.block.answers).toEqual(answers);
    expect(prompt).toContain(
      formatQuestionAnswersBlock(questionBatchId, answers),
    );
    expect(prompt).toContain("## Your Question Was Answered");
  });

  it("omits the answers section when resumeUserInput is undefined", () => {
    const followUp = buildFollowUpPrompt({
      remainingTasks: [makeTask()],
      taskStates: {},
      attemptNumber: 1,
      maxAttempts: 3,
    });
    const seed = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });

    expect(splitQuestionAnswersBlock(followUp)).toBeNull();
    expect(splitQuestionAnswersBlock(seed)).toBeNull();
    expect(followUp).not.toContain("## Your Question Was Answered");
    expect(seed).not.toContain("## Your Question Was Answered");
  });
});

describe("ask-protocol reminder (Req 8.1-8.4)", () => {
  const heading = "## Asking the User";

  it("buildIterationPrompt adds the protocol reminder when askUserQuestionsEnabled is true", () => {
    const prompt = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      askUserQuestionsEnabled: true,
    });

    expect(prompt).toContain(heading);
    // The tool is available for questions to the user.
    expect(prompt).toContain("cctl ask");
    expect(prompt).toMatch(/available/i);
    // Ask only at consequential / hard-to-reverse / genuinely ambiguous forks.
    expect(prompt).toMatch(/consequential/i);
    expect(prompt).toMatch(/hard-to-reverse/i);
    expect(prompt).toMatch(/ambiguous/i);
    // Batch related questions into one call.
    expect(prompt).toMatch(/batch/i);
    // End the turn after asking.
    expect(prompt).toMatch(/end your turn/i);
    // Answers arrive when the context resumes.
    expect(prompt).toMatch(/resume/i);
    // Skipped means proceed with best judgment.
    expect(prompt).toMatch(/skipped/i);
    expect(prompt).toMatch(/best judgment/i);
    // The workflow pauses the context until answered (asking is not free).
    expect(prompt).toMatch(/pause/i);
  });

  it("buildFollowUpPrompt adds the protocol reminder when askUserQuestionsEnabled is true", () => {
    const prompt = buildFollowUpPrompt({
      remainingTasks: [makeTask()],
      taskStates: {},
      attemptNumber: 1,
      maxAttempts: 3,
      askUserQuestionsEnabled: true,
    });

    expect(prompt).toContain(heading);
    expect(prompt).toContain("cctl ask");
    expect(prompt).toMatch(/end your turn/i);
    expect(prompt).toMatch(/pause/i);
    expect(prompt).toMatch(/best judgment/i);
  });

  it("omits the reminder when askUserQuestionsEnabled is false or undefined", () => {
    const seedDisabled = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
      askUserQuestionsEnabled: false,
    });
    const seedUnset = buildIterationPrompt({
      context: makeContext(),
      tasks: [makeTask()],
      taskStates: {},
      sharedDocuments: [],
      allowAgentTaskAdd: false,
    });
    const followUpDisabled = buildFollowUpPrompt({
      remainingTasks: [makeTask()],
      taskStates: {},
      attemptNumber: 1,
      maxAttempts: 3,
      askUserQuestionsEnabled: false,
    });
    const followUpUnset = buildFollowUpPrompt({
      remainingTasks: [makeTask()],
      taskStates: {},
      attemptNumber: 1,
      maxAttempts: 3,
    });

    expect(seedDisabled).not.toContain(heading);
    expect(seedUnset).not.toContain(heading);
    expect(followUpDisabled).not.toContain(heading);
    expect(followUpUnset).not.toContain(heading);
  });
});
