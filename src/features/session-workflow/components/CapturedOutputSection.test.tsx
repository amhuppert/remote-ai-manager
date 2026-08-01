// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CapturedOutputSection, {
  resolveCapturedOutputView,
  type CapturedOutputView,
} from "./CapturedOutputSection";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowValidationResultEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowContextOutput } from "@/lib/workflow-graph/schemas";

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "blocked"] },
    confidence: { type: "number" },
    notes: { type: "string" },
  },
  required: ["verdict", "confidence"],
} as const;

function capturedView(
  overrides: Partial<GraphWorkflowContextOutput> = {},
): CapturedOutputView {
  return {
    kind: "captured",
    output: {
      value: { verdict: "pass", confidence: 0.9 },
      capturedAt: "2026-03-27T14:22:00.000Z",
      iteration: 2,
      parse: { source: "native" },
      ...overrides,
    },
  };
}

describe("CapturedOutputSection", () => {
  it("renders nothing when the context declares no output schema (R7.6)", () => {
    const { container } = render(<CapturedOutputSection view={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the pending state as a dashed box with a contract summary (R7.6)", () => {
    render(
      <CapturedOutputSection
        view={{ kind: "pending", outputSchema: { ...SCHEMA } }}
      />,
    );

    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    const box = screen.getByTestId("captured-output-pending");
    expect(box.className).toContain("border-dashed");
    expect(screen.getByTestId("captured-output-contract")).toHaveTextContent(
      "object · 3 fields · 2 required",
    );
    // No captured chrome before completion.
    expect(
      screen.queryByRole("button", { name: /copy output/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the captured state with a green chip, provenance strip and JSON tree (R7.6)", () => {
    render(<CapturedOutputSection view={capturedView()} />);

    expect(screen.getByText("Captured")).toHaveAttribute("data-tone", "green");
    // Native extraction is the unremarkable path — neutral tone.
    expect(screen.getByTestId("captured-output-parse")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(screen.getByTestId("captured-output-parse")).toHaveTextContent(
      "parse · native",
    );
    // The repair chip's presence IS the signal, so it is absent without one.
    expect(
      screen.queryByTestId("captured-output-repair"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("captured-output-provenance")).toHaveTextContent(
      /iteration 2/,
    );
    expect(screen.getByText('"verdict":')).toBeInTheDocument();
  });

  it("tones a non-native parse source amber and shows the repair chip when a repair turn ran (R7.6)", () => {
    render(
      <CapturedOutputSection
        view={capturedView({
          value: { verdict: "pass" },
          iteration: 3,
          parse: { source: "fenced", repaired: true, repairAttempts: 1 },
        })}
      />,
    );

    expect(screen.getByTestId("captured-output-parse")).toHaveAttribute(
      "data-tone",
      "amber",
    );
    expect(screen.getByTestId("captured-output-repair")).toHaveTextContent(
      "repair turn · 1",
    );
  });

  it("copies the captured payload and confirms (R7.6)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CapturedOutputSection view={capturedView()} />);
    fireEvent.click(screen.getByRole("button", { name: /copy output/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copied/i }),
      ).toBeInTheDocument();
    });
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ verdict: "pass", confidence: 0.9 }, null, 2),
    );
  });

  it("renders the rejected state with the kept-for-inspection note (R3.2)", () => {
    render(
      <CapturedOutputSection
        view={{
          kind: "rejected",
          rejectedOutput: '{ "verdict": "partial" }',
          iteration: 3,
          occurredAt: "2026-03-27T09:41:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Rejected")).toHaveAttribute("data-tone", "red");
    expect(screen.getByTestId("captured-output-rejected")).toHaveTextContent(
      '"verdict": "partial"',
    );
    expect(
      screen.getByTestId("captured-output-rejected-note"),
    ).toHaveTextContent(/kept for inspection/i);
  });
});

describe("resolveCapturedOutputView", () => {
  const definitionWithSchema = createResolvedWorkflowDefinition();
  beforeEach(() => {
    const target = definitionWithSchema.executionContexts[0];
    if (target) {
      Object.assign(target, { outputSchema: { ...SCHEMA } });
    }
  });

  function rejectionEvent(): GraphWorkflowValidationResultEvent & {
    occurredAt: string;
  } {
    return {
      type: "graph-workflow-validation-result",
      projectName: "project",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-plan",
      validatorType: "context",
      kind: "output_schema",
      pass: false,
      summary: "Output rejected",
      reopenTaskIds: [],
      issues: [{ title: "/verdict", description: "not allowed" }],
      rejectedOutput: '{ "verdict": "partial" }',
      gateRepairAttempts: null,
      gateRepairBudget: null,
      occurredAt: "2026-03-27T09:41:00.000Z",
    };
  }

  it("returns null for a context with no declared schema", () => {
    const execution = createWorkflowExecution();
    expect(resolveCapturedOutputView(execution, "context-plan", [])).toBeNull();
  });

  // R7.6: "absent when no schema is declared" has to hold against the CURRENT
  // definition — a live edit can clear the contract after a payload was banked,
  // and the group must not keep reporting Captured against a contract that is
  // gone.
  it("returns null when the schema was cleared after an output was banked", () => {
    const execution = createWorkflowExecution({
      contextOutputs: {
        "context-plan": {
          value: { verdict: "pass", confidence: 1 },
          capturedAt: "2026-03-27T09:45:00.000Z",
          iteration: 4,
          parse: { source: "native" },
        },
      },
    });
    expect(resolveCapturedOutputView(execution, "context-plan", [])).toBeNull();
  });

  it("returns pending for a declared-but-uncaptured context", () => {
    const execution = createWorkflowExecution({
      workingDefinition: definitionWithSchema,
    });
    expect(resolveCapturedOutputView(execution, "context-plan", [])).toEqual({
      kind: "pending",
      outputSchema: { ...SCHEMA },
    });
  });

  it("prefers the latest rejection over pending while nothing is captured", () => {
    const execution = createWorkflowExecution({
      workingDefinition: definitionWithSchema,
    });
    const view = resolveCapturedOutputView(execution, "context-plan", [
      rejectionEvent(),
    ]);
    expect(view).toEqual({
      kind: "rejected",
      rejectedOutput: '{ "verdict": "partial" }',
      iteration: 0,
      occurredAt: "2026-03-27T09:41:00.000Z",
    });
  });

  it("returns the captured output even when an earlier attempt was rejected", () => {
    const execution = createWorkflowExecution({
      workingDefinition: definitionWithSchema,
      contextOutputs: {
        "context-plan": {
          value: { verdict: "pass", confidence: 1 },
          capturedAt: "2026-03-27T09:45:00.000Z",
          iteration: 4,
          parse: { source: "native" },
        },
      },
    });
    const view = resolveCapturedOutputView(execution, "context-plan", [
      rejectionEvent(),
    ]);
    expect(view?.kind).toBe("captured");
  });

  // The Edit-schema action on the halt surfaces replaces the contract while
  // the rejection stays in history. That rejection measured a contract this
  // context no longer has, so it cannot stand in for the current one.
  it("returns pending when the only rejection was measured against a replaced contract", () => {
    const execution = createWorkflowExecution({
      workingDefinition: definitionWithSchema,
    });
    const view = resolveCapturedOutputView(execution, "context-plan", [
      {
        ...rejectionEvent(),
        rejectedAgainstSchema: { type: "object", properties: {} },
      },
    ]);
    expect(view).toEqual({ kind: "pending", outputSchema: { ...SCHEMA } });
  });

  it("keeps the rejection when it was measured against the current contract", () => {
    const execution = createWorkflowExecution({
      workingDefinition: definitionWithSchema,
    });
    const view = resolveCapturedOutputView(execution, "context-plan", [
      {
        ...rejectionEvent(),
        // Same contract, re-serialized in a different key order — persistence
        // canonicalizes JSON, so identity cannot be a string comparison.
        rejectedAgainstSchema: {
          required: [...SCHEMA.required],
          properties: { ...SCHEMA.properties },
          type: SCHEMA.type,
        },
      },
    ]);
    expect(view?.kind).toBe("rejected");
  });

  it("ignores agent-validator failures when looking for a rejection", () => {
    const execution = createWorkflowExecution({
      workingDefinition: definitionWithSchema,
    });
    const view = resolveCapturedOutputView(execution, "context-plan", [
      { ...rejectionEvent(), kind: "context_validation", rejectedOutput: null },
    ]);
    expect(view?.kind).toBe("pending");
  });
});
