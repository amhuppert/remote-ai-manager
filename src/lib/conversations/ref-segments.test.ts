import { describe, it, expect } from "vitest";
import { segmentTextByRefs } from "./ref-segments";
import { buildMessageRefXml } from "./message-ref";

const CONVERSATION_REF =
  '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
  'session-name="main" worktree-path="/repos/my-app/.worktrees/main" ' +
  'conversation-id="conv-1" conversation-name="Refactor parser" ' +
  'backend="claude" backend-ref="sess-abc" debug-log-path="" status="running" ' +
  'last-activity-at="2026-06-01T12:00:00Z" compact-status="none" ' +
  'read-command="cctl conversation read conv-1 --outline" />';

const MESSAGE_REF = buildMessageRefXml({
  projectName: "my-app",
  sessionName: "main",
  conversationId: "conv-2",
  conversationName: "Fix flake",
  messageIndex: 7,
  role: "assistant",
  timestamp: "2026-07-06T12:00:00Z",
  model: "opus",
  compaction: null,
});

describe("segmentTextByRefs", () => {
  it("returns a single text segment when there is no ref", () => {
    expect(segmentTextByRefs("plain text")).toEqual([
      { type: "text", text: "plain text" },
    ]);
  });

  it("splits text around a conversation-ref and validates its attributes", () => {
    const segments = segmentTextByRefs(`before ${CONVERSATION_REF} after`);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", text: "before " });
    expect(segments[1]!.type).toBe("conversation-ref");
    if (segments[1]!.type === "conversation-ref") {
      expect(segments[1]!.attrs["conversation-id"]).toBe("conv-1");
      expect(segments[1]!.attrs.backend).toBe("claude");
    }
    expect(segments[2]).toEqual({ type: "text", text: " after" });
  });

  it("splits text around a message-ref and validates its attributes", () => {
    const segments = segmentTextByRefs(`x ${MESSAGE_REF} y`);
    expect(segments).toHaveLength(3);
    expect(segments[1]!.type).toBe("message-ref");
    if (segments[1]!.type === "message-ref") {
      expect(segments[1]!.attrs["conversation-id"]).toBe("conv-2");
      expect(segments[1]!.attrs["message-index"]).toBe("7");
    }
  });

  it("interleaves both ref kinds in document order", () => {
    const segments = segmentTextByRefs(
      `a ${MESSAGE_REF} b ${CONVERSATION_REF} c`,
    );
    expect(segments.map((s) => s.type)).toEqual([
      "text",
      "message-ref",
      "text",
      "conversation-ref",
      "text",
    ]);
  });

  it("leaves refs that fail schema validation inside the text", () => {
    const badConv = '<conversation-ref project-name="x" conversation-id="y" />';
    const badMsg = '<message-ref role="assistant" compacted="false" />';
    expect(segmentTextByRefs(`p ${badConv} q ${badMsg} r`)).toEqual([
      { type: "text", text: `p ${badConv} q ${badMsg} r` },
    ]);
  });

  it("skips refs inside fenced code blocks", () => {
    expect(
      segmentTextByRefs(`\`\`\`\n${CONVERSATION_REF}\n${MESSAGE_REF}\n\`\`\``),
    ).toEqual([
      {
        type: "text",
        text: `\`\`\`\n${CONVERSATION_REF}\n${MESSAGE_REF}\n\`\`\``,
      },
    ]);
  });

  it("decodes XML entities in ref attribute values", () => {
    const ref = CONVERSATION_REF.replace(
      'conversation-name="Refactor parser"',
      'conversation-name="A &amp; B"',
    );
    const segments = segmentTextByRefs(ref);
    expect(segments).toHaveLength(1);
    if (segments[0]!.type === "conversation-ref") {
      expect(segments[0]!.attrs["conversation-name"]).toBe("A & B");
    }
  });
});
