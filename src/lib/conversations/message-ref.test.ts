import { describe, it, expect } from "vitest";
import { findMessageRefs } from "./ref-parser";
import { buildMessageRefXml, type MessageRefInput } from "./message-ref";
import { messageRefAttrsSchema } from "./schemas";

function input(overrides: Partial<MessageRefInput> = {}): MessageRefInput {
  return {
    projectName: "my-app",
    sessionName: "main",
    conversationId: "conv-123",
    conversationName: "Refactor parser",
    messageIndex: 5,
    role: "assistant",
    timestamp: "2026-07-06T12:00:00Z",
    model: "opus",
    compaction: { artifactId: "art-1", createdAt: "2026-07-05T10:30:00Z" },
    ...overrides,
  };
}

describe("buildMessageRefXml", () => {
  it("emits every attribute plus both cctl commands when a compaction exists", () => {
    expect(buildMessageRefXml(input())).toBe(
      '<message-ref project-name="my-app" session-name="main" ' +
        'conversation-id="conv-123" conversation-name="Refactor parser" ' +
        'message-index="5" role="assistant" timestamp="2026-07-06T12:00:00Z" ' +
        'model="opus" compacted="true" compact-artifact-id="art-1" ' +
        'compact-created-at="2026-07-05T10:30:00Z" ' +
        'compaction-command="cctl conversation compaction get conv-123 --message 5 --json" ' +
        'read-command="cctl conversation read conv-123 --message 5" />',
    );
  });

  it("omits compaction detail and command when no compaction exists", () => {
    const xml = buildMessageRefXml(input({ compaction: null }));
    expect(xml).toContain('compacted="false"');
    expect(xml).not.toContain("compact-artifact-id");
    expect(xml).not.toContain("compact-created-at");
    expect(xml).not.toContain("compaction-command");
    expect(xml).toContain(
      'read-command="cctl conversation read conv-123 --message 5"',
    );
  });

  it("omits session-name, conversation-name, timestamp and model when absent", () => {
    const xml = buildMessageRefXml(
      input({
        sessionName: null,
        conversationName: null,
        timestamp: null,
        model: null,
        compaction: null,
      }),
    );
    expect(xml).not.toContain("session-name");
    expect(xml).not.toContain("conversation-name");
    expect(xml).not.toContain("timestamp");
    expect(xml).not.toContain("model");
    expect(xml).toContain('project-name="my-app"');
    expect(xml).toContain('message-index="5"');
    expect(xml).toContain('role="assistant"');
  });

  it("escapes XML special characters in attribute values", () => {
    const xml = buildMessageRefXml(
      input({ conversationName: 'Fix "a" <b> & c', compaction: null }),
    );
    expect(xml).toContain(
      'conversation-name="Fix &quot;a&quot; &lt;b&gt; &amp; c"',
    );
  });

  it("produces a tag whose parsed attributes satisfy messageRefAttrsSchema", () => {
    const xml = buildMessageRefXml(input());
    const refs = findMessageRefs(xml);
    expect(refs).toHaveLength(1);
    const parsed = messageRefAttrsSchema.safeParse(refs[0]!.attrs);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data["project-name"]).toBe("my-app");
      expect(parsed.data["message-index"]).toBe("5");
      expect(parsed.data.compacted).toBe("true");
      expect(parsed.data["compaction-command"]).toBe(
        "cctl conversation compaction get conv-123 --message 5 --json",
      );
    }
  });
});

describe("findMessageRefs", () => {
  it("finds refs in surrounding prose", () => {
    const xml = buildMessageRefXml(input());
    const refs = findMessageRefs(`Look at ${xml} for details`);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.raw).toBe(xml);
    expect(refs[0]!.attrs["conversation-id"]).toBe("conv-123");
  });

  it("skips refs inside fenced code blocks", () => {
    const xml = buildMessageRefXml(input());
    expect(findMessageRefs(`\`\`\`\n${xml}\n\`\`\``)).toHaveLength(0);
  });

  it("does not match conversation-ref tags", () => {
    const text = '<conversation-ref project-name="p" conversation-id="c" />';
    expect(findMessageRefs(text)).toHaveLength(0);
  });
});
