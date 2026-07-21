import { describe, it, expect } from "vitest";
import { findConversationRefs } from "./ref-parser";
import {
  buildConversationRefXml,
  buildConversationRefXmlFromListItem,
  conversationListItemToMentionAttrs,
} from "./conversation-ref";
import { conversationRefAttrsSchema } from "./schemas";
import type { ConversationListItem } from "./schemas";

function listItem(
  overrides: Partial<ConversationListItem> = {},
): ConversationListItem {
  return {
    projectName: "my-app",
    projectPath: "/repos/my-app",
    sessionName: "main",
    worktreePath: "/repos/my-app/.worktrees/main",
    conversationId: "conv-123",
    conversationName: "Refactor parser",
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: { backend: "claude", ref: "claude-sess-abc" },
    transcriptPath: null,
    debugLogPath: null,
    status: "running",
    lastActivityAt: "2024-06-01T12:00:00Z",
    archived: false,
    ...overrides,
  };
}

describe("buildConversationRefXmlFromListItem", () => {
  it("emits the canonical conversation-ref XML without compaction", () => {
    expect(buildConversationRefXmlFromListItem(listItem())).toBe(
      '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
        'session-name="main" worktree-path="/repos/my-app/.worktrees/main" ' +
        'conversation-id="conv-123" conversation-name="Refactor parser" ' +
        'backend="claude" backend-ref="claude-sess-abc" debug-log-path="" ' +
        'status="running" last-activity-at="2024-06-01T12:00:00Z" ' +
        'compact-status="none" ' +
        'read-command="cctl conversation read conv-123 --outline" />',
    );
  });

  it("advertises compaction details and command when a compaction exists", () => {
    const xml = buildConversationRefXmlFromListItem(
      listItem({
        compactArtifactId: "art-9",
        compactStatus: "fresh",
        compactCoveredSeq: "0..42",
        compactCreatedAt: "2024-06-01T10:00:00Z",
      }),
    );
    expect(xml).toContain('compact-status="fresh"');
    expect(xml).toContain('compact-artifact-id="art-9"');
    expect(xml).toContain('compact-covered-seq="0..42"');
    expect(xml).toContain('compact-created-at="2024-06-01T10:00:00Z"');
    expect(xml).toContain(
      'compaction-command="cctl conversation compaction get conv-123 --json"',
    );
  });

  it("produces a tag whose parsed attributes satisfy conversationRefAttrsSchema", () => {
    const xml = buildConversationRefXmlFromListItem(listItem());
    const refs = findConversationRefs(xml);
    expect(refs).toHaveLength(1);
    const parsed = conversationRefAttrsSchema.safeParse(refs[0]!.attrs);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data["conversation-id"]).toBe("conv-123");
      expect(parsed.data["read-command"]).toBe(
        "cctl conversation read conv-123 --outline",
      );
    }
  });

  it("escapes XML special characters in attribute values", () => {
    const xml = buildConversationRefXmlFromListItem(
      listItem({ conversationName: 'Fix "a" <b> & c' }),
    );
    expect(xml).toContain(
      'conversation-name="Fix &quot;a&quot; &lt;b&gt; &amp; c"',
    );
  });
});

describe("conversationListItemToMentionAttrs", () => {
  it("maps a list item onto camelCase mention attrs with empty-string absences", () => {
    expect(conversationListItemToMentionAttrs(listItem())).toEqual({
      projectName: "my-app",
      projectPath: "/repos/my-app",
      sessionName: "main",
      worktreePath: "/repos/my-app/.worktrees/main",
      conversationId: "conv-123",
      conversationName: "Refactor parser",
      backend: "claude",
      backendRef: "claude-sess-abc",
      transcriptPath: "",
      debugLogPath: "",
      status: "running",
      lastActivityAt: "2024-06-01T12:00:00Z",
      compactArtifactId: "",
      compactStatus: "none",
      compactCoveredSeq: "",
      compactCreatedAt: "",
    });
  });

  it("nulls become empty strings and compaction fields pass through", () => {
    const attrs = conversationListItemToMentionAttrs(
      listItem({
        conversationName: null,
        backendRef: null,
        transcriptPath: "/tmp/t.jsonl",
        debugLogPath: "/tmp/d.ndjson",
        compactArtifactId: "art-9",
        compactStatus: "stale",
        compactCoveredSeq: "0..10",
        compactCreatedAt: "2024-06-01T10:00:00Z",
      }),
    );
    expect(attrs.conversationName).toBe("");
    expect(attrs.backendRef).toBe("");
    expect(attrs.transcriptPath).toBe("/tmp/t.jsonl");
    expect(attrs.debugLogPath).toBe("/tmp/d.ndjson");
    expect(attrs.compactStatus).toBe("stale");
    expect(attrs.compactArtifactId).toBe("art-9");
  });
});

describe("buildConversationRefXml", () => {
  it("treats unknown compact-status values as none and drops detail attrs", () => {
    const attrs = {
      ...conversationListItemToMentionAttrs(listItem()),
      compactStatus: "bogus",
      compactArtifactId: "art-9",
    };
    const xml = buildConversationRefXml(attrs);
    expect(xml).toContain('compact-status="none"');
    expect(xml).not.toContain("compact-artifact-id");
    expect(xml).not.toContain("compaction-command");
  });
});
