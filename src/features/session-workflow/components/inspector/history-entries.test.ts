import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import { getHistoryEntries } from "./history-entries";

function validationEvent(
  overrides: Partial<GraphWorkflowValidationResultEvent> = {},
): GraphWorkflowValidationResultEvent {
  return {
    type: "graph-workflow-validation-result",
    projectName: "project",
    sessionName: "session-1",
    executionId: "execution-1",
    contextId: "context-plan",
    validatorType: "context",
    kind: "context_validation",
    rejectedOutput: null,
    gateRepairAttempts: null,
    gateRepairBudget: null,
    pass: true,
    summary: "All good",
    issues: [],
    reopenTaskIds: [],
    ...overrides,
  };
}

function entry(
  event: GraphWorkflowValidationResultEvent,
  preReset: boolean,
  occurredAt = "2026-03-27T10:00:00.000Z",
): GraphWorkflowExecutionEvent {
  return { occurredAt, event, preReset };
}

describe("getHistoryEntries", () => {
  it("leaves out every row a context reset retired", () => {
    const events = [
      entry(validationEvent({ summary: "Discarded by reset" }), true),
      entry(
        validationEvent({ summary: "Kept after reset" }),
        false,
        "2026-03-27T10:01:00.000Z",
      ),
    ];

    expect(
      getHistoryEntries(events).validationEvents.map((event) => event.summary),
    ).toEqual(["Kept after reset"]);
  });

  // The timestamp cannot order the log on its own — consecutive mutations share
  // milliseconds — so each slice carries the position it was read at, and every
  // reader of "what was in force here" asks with that.
  it("carries each entry's position in the stream it was read from", () => {
    const events = [
      entry(validationEvent({ summary: "older" }), false),
      entry(
        validationEvent({ summary: "newer" }),
        false,
        "2026-03-27T10:00:00.000Z",
      ),
    ];

    expect(
      getHistoryEntries(events).validationEvents.map((event) => [
        event.summary,
        event.logIndex,
      ]),
    ).toEqual([
      ["newer", 1],
      ["older", 0],
    ]);
  });

  it("orders the current attempt newest-first", () => {
    const events = [
      entry(validationEvent({ summary: "older" }), false),
      entry(
        validationEvent({ summary: "newer" }),
        false,
        "2026-03-27T10:05:00.000Z",
      ),
    ];

    expect(
      getHistoryEntries(events).validationEvents.map((event) => event.summary),
    ).toEqual(["newer", "older"]);
  });

  it("scopes to one context when asked, and to the whole run when not", () => {
    const events = [
      entry(validationEvent({ contextId: "context-plan" }), false),
      entry(validationEvent({ contextId: "context-implement" }), false),
    ];

    expect(getHistoryEntries(events).validationEvents).toHaveLength(2);
    expect(
      getHistoryEntries(events, "context-plan").validationEvents,
    ).toHaveLength(1);
  });

  it("reads incidents oldest-first, because a round is diagnosed in order", () => {
    const events: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-validation-incident",
          projectName: "project",
          sessionName: "session-1",
          executionId: "execution-1",
          contextId: "context-plan",
          incident: "infra_failure",
          roundSeq: 1,
          stage: "specialist_result",
          assignmentId: "security",
          attempts: 1,
          driftedComponents: "",
          message: "first",
        },
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-validation-incident",
          projectName: "project",
          sessionName: "session-1",
          executionId: "execution-1",
          contextId: "context-plan",
          incident: "infra_exhausted",
          roundSeq: 1,
          stage: "specialist_result",
          assignmentId: "security",
          attempts: 2,
          driftedComponents: "",
          message: "second",
        },
      },
    ];

    expect(
      getHistoryEntries(events).incidentEvents.map((event) => event.message),
    ).toEqual(["first", "second"]);
  });
});
