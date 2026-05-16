import { describe, it, expect } from "vitest";
import { deriveLastActivitySummary } from "./active-conversations-route-handlers";
import type { TranscriptMessage, ConversationStatus } from "@/types";

function convo(
  status: ConversationStatus,
  pendingQuestions: { question: string }[] | null = null,
) {
  return { status, pendingQuestions };
}

function assistantMessage(
  content: TranscriptMessage["content"],
): TranscriptMessage {
  return {
    role: "assistant",
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("deriveLastActivitySummary", () => {
  it("returns null for status 'new'", () => {
    expect(deriveLastActivitySummary(convo("new"), null)).toBeNull();
  });

  it("returns the truncated first pending question for status 'awaiting'", () => {
    const result = deriveLastActivitySummary(
      convo("awaiting", [{ question: "Do you want to proceed with this?" }]),
      null,
    );
    expect(result).toBe("Do you want to proceed with this?");
  });

  it("returns the truncated first pending question for status 'waiting_for_input'", () => {
    const result = deriveLastActivitySummary(
      convo("waiting_for_input", [
        { question: "Which option fits your goal?" },
      ]),
      null,
    );
    expect(result).toBe("Which option fits your goal?");
  });

  it("returns null for an awaiting conversation that has no pending question text", () => {
    expect(deriveLastActivitySummary(convo("awaiting", null), null)).toBeNull();
  });

  it("truncates pending question text to <=80 characters", () => {
    const longQ = "x".repeat(200);
    const result = deriveLastActivitySummary(
      convo("awaiting", [{ question: longQ }]),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
  });

  it("collapses newlines into single spaces in pending question text", () => {
    const result = deriveLastActivitySummary(
      convo("awaiting", [{ question: "Line one\nLine two\n  Line three" }]),
      null,
    );
    expect(result).toBe("Line one Line two Line three");
    expect(result!).not.toMatch(/\n/);
  });

  it("returns null for a running conversation with no transcript message", () => {
    expect(deriveLastActivitySummary(convo("running"), null)).toBeNull();
  });

  it("summarizes a running conversation's latest Edit tool_use as 'Editing <path>'", () => {
    const msg = assistantMessage([
      {
        type: "tool_use",
        name: "Edit",
        input: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
      },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Editing src/foo.ts",
    );
  });

  it("summarizes a Write tool_use as 'Editing <path>'", () => {
    const msg = assistantMessage([
      { type: "tool_use", name: "Write", input: { file_path: "src/bar.ts" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Editing src/bar.ts",
    );
  });

  it("summarizes a Read tool_use as 'Reading <path>'", () => {
    const msg = assistantMessage([
      { type: "tool_use", name: "Read", input: { file_path: "src/baz.ts" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Reading src/baz.ts",
    );
  });

  it("summarizes a Bash tool_use as 'Running: <command>'", () => {
    const msg = assistantMessage([
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "bun run test" },
      },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Running: bun run test",
    );
  });

  it("summarizes a Grep tool_use as 'Searching <pattern>'", () => {
    const msg = assistantMessage([
      { type: "tool_use", name: "Grep", input: { pattern: "useState" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Searching useState",
    );
  });

  it("falls back to the latest text block when no tool_use exists", () => {
    const msg = assistantMessage([
      { type: "text", text: "Working through the plan now." },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Working through the plan now.",
    );
  });

  it("prefers the last tool_use over an earlier text block", () => {
    const msg = assistantMessage([
      { type: "text", text: "Thinking out loud." },
      { type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts" } },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBe(
      "Editing src/foo.ts",
    );
  });

  it("truncates long running-status summaries to <=80 characters with an ellipsis", () => {
    const cmd = "very-long-command ".repeat(20);
    const msg = assistantMessage([
      { type: "tool_use", name: "Bash", input: { command: cmd } },
    ]);
    const result = deriveLastActivitySummary(convo("running"), msg);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    expect(result!.endsWith("…")).toBe(true);
  });

  it("returns null when the latest assistant message has no recognizable content", () => {
    const msg = assistantMessage([
      { type: "tool_result", tool_use_id: "x", content: "hidden" },
    ]);
    expect(deriveLastActivitySummary(convo("running"), msg)).toBeNull();
  });

  it("never contains newlines in the derived summary", () => {
    const msg = assistantMessage([
      { type: "text", text: "Line A\nLine B\nLine C" },
    ]);
    const result = deriveLastActivitySummary(convo("running"), msg);
    expect(result).not.toBeNull();
    expect(result!).not.toMatch(/\n/);
  });
});
