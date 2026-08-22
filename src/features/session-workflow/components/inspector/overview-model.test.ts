import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { deriveOverviewSummary, type OverviewRowId } from "./overview-model";

/** A run halted on a conflicted join — the join's own state carries the roster. */
function haltedOnJoinExecution(): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "halted" });
  const joinId = "join_delivery_1";
  return {
    ...base,
    haltReason: {
      type: "join_failure",
      joinId,
      joinKind: "context_merge",
      contextId: "context-implement",
      sourceLaneIds: ["lane-plan", "lane-implement"],
      targetLaneId: "delivery",
      message: "merge conflict",
      conflictFiles: ["src/checkout/audit.ts"],
    },
    joins: {
      [joinId]: {
        joinId,
        kind: "context_merge",
        contextId: "context-implement",
        targetLaneId: "delivery",
        sourceLaneIds: ["lane-plan", "lane-implement"],
        mergedSourceLaneIds: ["lane-plan"],
        validationDebtSourceLaneIds: [],
        sourceLaneContextIds: {
          "lane-plan": ["context-plan"],
          "lane-implement": ["context-implement"],
        },
        status: "conflicts",
        errorMessage: "both wrote the timeout branch",
        conflicts: {
          files: ["src/checkout/audit.ts"],
          message: "merge conflict",
          analysis: null,
        },
        conflictGuidance: null,
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-21T10:05:00.000Z",
        completedAt: null,
      },
    },
  };
}

function rowOf(
  summary: ReturnType<typeof deriveOverviewSummary>,
  id: OverviewRowId,
) {
  const row = summary.rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no ${id} row`);
  return row;
}

function summarize(
  execution: GraphWorkflowExecution,
  events: GraphWorkflowExecutionEvent[] = [],
  draftRevision?: number | null,
) {
  return deriveOverviewSummary({
    execution,
    events,
    ...(draftRevision === undefined ? {} : { draftRevision }),
  });
}

describe("deriveOverviewSummary — Launch card", () => {
  it("states the launched revision, the seed and the bound inputs", () => {
    const execution = createWorkflowExecution({
      seedDefinitionId: "wf_checkout_v2",
      seedDefinitionRevision: 4,
      boundInputs: { target_branch: "main", rollout: "canary" },
    });

    const { launch } = summarize(execution);

    expect(launch.revisionLabel).toBe("definition r4");
    expect(launch.seedLabel).toBe("wf_checkout_v2@4");
    expect(launch.runLabel).toBe("execution-1");
    expect(launch.originLabel).toContain("wf_checkout_v2");
    expect(launch.inputs).toEqual([
      { name: "target_branch", value: "main" },
      { name: "rollout", value: "canary" },
    ]);
  });

  it("names a one-off run's plan rather than a definition it does not have", () => {
    const execution = createWorkflowExecution({
      origin: { kind: "one_off", planName: "Hotfix the timeout path" },
    });

    expect(summarize(execution).launch.originLabel).toContain(
      "Hotfix the timeout path",
    );
  });

  it("warns that a moved-on builder draft does not reach this run", () => {
    const execution = createWorkflowExecution({ seedDefinitionRevision: 4 });

    expect(summarize(execution, [], 5).launch.draftNote).toBe(
      "The builder draft is r5. Saved edits do not reach this run.",
    );
  });

  it("carries no draft note when the draft still matches the launch snapshot", () => {
    const execution = createWorkflowExecution({ seedDefinitionRevision: 4 });

    expect(summarize(execution, [], 4).launch.draftNote).toBeNull();
    expect(summarize(execution).launch.draftNote).toBeNull();
  });
});

describe("deriveOverviewSummary — Shape card", () => {
  it("counts contexts, tasks, edges, joins and lanes of the working definition", () => {
    const execution = createWorkflowExecution();

    const { shape } = summarize(execution);

    expect(shape).toMatchObject({
      contexts: 3,
      tasks: 3,
      edges: 2,
      joins: 0,
      lanes: 3,
    });
    expect(shape.label).toBe(
      "3 contexts · 3 tasks · 2 edges · 0 joins · 3 lanes",
    );
  });
});

describe("deriveOverviewSummary — Gates row", () => {
  it("counts context approvals and parked questions awaiting the human", () => {
    const base = createWorkflowExecution({ status: "running" });
    const planState = base.contextStates["context-plan"]!;
    const implementState = base.contextStates["context-implement"]!;
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...planState,
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-03-27T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        },
        "context-implement": {
          ...implementState,
          status: "awaiting_user_input",
          pendingUserInputs: {
            implementer: {
              lane: "implementer",
              roundSeq: 1,
              conversationId: "conv-1",
              questionBatchId: "batch-1",
              questions: [
                {
                  id: "q1",
                  question: "Which branch?",
                  header: "Branch",
                  multiSelect: false,
                  required: true,
                  allowNote: true,
                  options: [
                    {
                      label: "main",
                      recommended: true,
                      description: "the trunk",
                    },
                  ],
                },
              ],
              requestedAt: "2026-03-27T10:00:00.000Z",
              answers: null,
            },
          },
        },
      },
    };

    const gates = rowOf(summarize(execution), "gates");

    expect(gates.summary).toBe("1 context approval · 1 parked question");
    expect(gates.tone).toBe("amber");
  });

  it("stays neutral and says so when nothing is waiting", () => {
    const gates = rowOf(summarize(createWorkflowExecution()), "gates");

    expect(gates.summary).toBe("nothing awaiting you");
    expect(gates.tone).toBe("neutral");
  });

  // The row summarises the same list the Gates screen renders and the status
  // bar's chip counts. A join conflict the list holds but the row omitted would
  // read "nothing awaiting you" above a screen with a row in it.
  it("counts a conflicted join alongside the other waits", () => {
    const gates = rowOf(summarize(haltedOnJoinExecution()), "gates");

    expect(gates.summary).toBe(
      "0 context approvals · 0 parked questions · 1 join conflict",
    );
    expect(gates.tone).toBe("amber");
  });
});

describe("deriveOverviewSummary — ledger and index rows", () => {
  it("reports the open advisory count", () => {
    const execution = createWorkflowExecution({
      advisoryIndex: [
        {
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 0 },
          kind: "plan",
          title: "Migration is not additive",
          contextId: "context-plan",
        },
      ],
    });

    expect(rowOf(summarize(execution), "advisories").summary).toContain(
      "1 open",
    );
  });

  it("says an execution ran no runtime expansion rather than hiding the row", () => {
    expect(
      rowOf(summarize(createWorkflowExecution()), "expansion-ledger").summary,
    ).toBe("no runtime expansion in this execution");
  });

  it("counts accepted and refused expansions when the ledger has entries", () => {
    const execution = createWorkflowExecution({
      expansionReceipts: {
        accepted: [
          {
            requestId: "req-1",
            invokerContextId: "context-plan",
            initiatorConversationId: "conv-1",
            addedContextIds: ["context-extra"],
            addedTaskIds: [],
            rejoinContextIds: [],
            rationale: "needs a spike",
            payloadHash: "abc123",
            liveRevision: 1,
            acceptedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
        refusals: [],
      },
    });

    expect(rowOf(summarize(execution), "expansion-ledger").summary).toBe(
      "1 accepted · 0 refused",
    );
  });

  it("counts shared documents", () => {
    const execution = createWorkflowExecution({
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: "docs/threat-model.md",
          description: "Threat model",
          readWhen: "Before touching the payment path",
          kind: "shared",
          createdAt: "2026-03-27T10:00:00.000Z",
          updatedAt: "2026-03-27T10:00:00.000Z",
          lastUpdatedByConversationId: null,
        },
      ],
    });

    expect(rowOf(summarize(execution), "documents").summary).toBe("1 shared");
  });

  it("counts events and circuit-breaker trips", () => {
    const execution = createWorkflowExecution();
    const events: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-circuit-breaker",
          projectName: "project",
          sessionName: "session-1",
          executionId: "execution-1",
          contextId: "context-plan",
          failureCount: 3,
          condition: "retry_exhaustion",
          summary: null,
        },
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-context-status",
          projectName: "project",
          sessionName: "session-1",
          executionId: "execution-1",
          contextId: "context-plan",
          status: "running",
          remainingTaskCount: 1,
          iterationCount: 1,
        },
      },
    ];

    expect(rowOf(summarize(execution, events), "events").summary).toBe(
      "2 events · 1 circuit-breaker trip",
    );
  });
});
