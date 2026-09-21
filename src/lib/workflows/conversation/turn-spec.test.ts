import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  conversationTurnRequestSchema,
  normalizeTurn,
  taskTurnRequestSchema,
} from "./turn-spec";

describe("turn normalization", () => {
  it("keeps generated JSON Schemas serializable across task normalization", () => {
    const schema = z.toJSONSchema(
      z.object({ title: z.string(), description: z.string() }),
    );
    const expected = JSON.parse(JSON.stringify(schema));
    const turn = normalizeTurn(
      {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "Generate a ticket",
        outputFormat: { type: "json_schema", schema },
        structuredOutputTurns: "single",
      },
      "cursor",
    );
    expect(turn.outputFormat?.schema).toEqual(expected);
    expect(turn.structuredOutputTurns).toBe("single");
    expect(structuredClone(turn).outputFormat?.schema).toEqual(expected);
    expect(Reflect.ownKeys(schema)).toContain("~standard");
  });

  it("preserves the structured-output mode on a conversation turn", () => {
    const turn = normalizeTurn(
      { promptText: "Review", structuredOutputTurns: "work_then_format" },
      "claude",
    );
    expect(turn.structuredOutputTurns).toBe("work_then_format");
    expect(structuredClone(turn).structuredOutputTurns).toBe(
      "work_then_format",
    );
  });

  it("normalizes defaults without losing an explicit disabled asking policy", () => {
    expect(
      normalizeTurn(
        { promptText: "", askUserQuestionsEnabled: false },
        "claude",
      ),
    ).toEqual({
      kind: "conversation_turn",
      promptText: "",
      backend: "claude",
      modelSelection: null,
      autonomous: false,
      images: [],
      askUserQuestionsEnabled: false,
    });
  });

  it("keeps task authority and a zero timeout on the task variant", () => {
    expect(
      normalizeTurn(
        {
          kind: "task_run",
          promptText: "inspect",
          executionClass: "governed-execution",
          requiresPrivilegedInstructions: true,
          timeoutMs: 0,
        },
        "codex",
      ),
    ).toEqual({
      kind: "task_run",
      promptText: "inspect",
      backend: "codex",
      modelSelection: null,
      executionClass: "governed-execution",
      requiresPrivilegedInstructions: true,
      timeoutMs: 0,
    });
  });

  it("refuses task-only fields on a conversation request", () => {
    const result = conversationTurnRequestSchema.safeParse({
      promptText: "inspect",
      executionClass: "governed-execution",
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["executionClass"],
        }),
      );
  });

  it("refuses conversation feedback on a task request", () => {
    const result = taskTurnRequestSchema.safeParse({
      kind: "task_run",
      promptText: "inspect",
      executionClass: "nongoverned-task",
      images: [],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["images"],
        }),
      );
  });
});
