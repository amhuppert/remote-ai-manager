import { describe, expect, it } from "vitest";
import { extractHandoffNote } from "./rotation-handoff";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";

function textBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

describe("extractHandoffNote", () => {
  it("joins the text blocks of the final assistant message", () => {
    const note = extractHandoffNote([
      textBlock("Completed task-1."),
      textBlock("Lesson: run the suite with WAL mode."),
    ]);

    expect(note).toBe(
      "Completed task-1.\n\nLesson: run the suite with WAL mode.",
    );
  });

  it("ignores non-text blocks and trims whitespace", () => {
    const blocks: MessageContentBlock[] = [
      {
        type: "tool_use",
        id: "tu-1",
        name: "Bash",
        input: { command: "ls" },
      },
      textBlock("  Done. \n"),
    ];

    expect(extractHandoffNote(blocks)).toBe("Done.");
  });

  it("returns null for null, empty, or text-free content", () => {
    expect(extractHandoffNote(null)).toBeNull();
    expect(extractHandoffNote([])).toBeNull();
    expect(extractHandoffNote([textBlock("   ")])).toBeNull();
  });

  it("truncates oversized notes at the limit with a marker", () => {
    const note = extractHandoffNote([textBlock("x".repeat(10_000))], 100);

    expect(note).not.toBeNull();
    expect(note!.length).toBeLessThanOrEqual(
      100 + "\n\n[handoff truncated]".length,
    );
    expect(note!.endsWith("[handoff truncated]")).toBe(true);
    expect(note!.startsWith("xxxx")).toBe(true);
  });
});
