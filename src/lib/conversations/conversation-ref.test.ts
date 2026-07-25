import type { SessionConversationListItem } from "./schemas";
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
  overrides: Partial<SessionConversationListItem> = {},
): ConversationListItem {
  return {
    projectName: "my-app",
    projectPath: "/repos/my-app",
    scope: "session" as const,
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

describe("project-scoped conversation refs (R1.3)", () => {
  const projectItem: ConversationListItem = {
    projectName: "my-app",
    projectPath: "/repos/my-app",
    scope: "project",
    worktreePath: "/repos/my-app",
    conversationId: "conv-p1",
    conversationName: "Project chat",
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status: "running",
    lastActivityAt: "2024-06-01T12:00:00Z",
    archived: false,
  };

  it("declares scope explicitly and carries no session-name attribute at all", () => {
    const xml = buildConversationRefXmlFromListItem(projectItem);

    expect(xml).toContain('scope="project"');
    // Not `session-name=""` — the project variant has no field for a session
    // name, so there is nowhere for the sentinel (or a stale name) to sit.
    expect(xml).not.toContain("session-name");
    expect(xml).not.toContain("__project__");
  });

  it("round-trips through the wire schema, which a bare session name could not", () => {
    const xml = buildConversationRefXmlFromListItem(projectItem);
    const [found] = findConversationRefs(xml);
    expect(found).toBeDefined();

    const parsed = conversationRefAttrsSchema.parse(found?.attrs);
    expect(parsed.scope).toBe("project");
    expect(parsed).not.toHaveProperty("session-name");
  });

  it("rejects a project ref that also carries a session name", () => {
    // An inconsistent combination: scope says the conversation has no owning
    // session while the payload names one. A flat object with an
    // always-present `session-name` accepted this.
    const result = conversationRefAttrsSchema.safeParse({
      "project-name": "my-app",
      "project-path": "/repos/my-app",
      scope: "project",
      "session-name": "main",
      "worktree-path": "/repos/my-app",
      "conversation-id": "conv-p1",
      "conversation-name": "Project chat",
      backend: "claude",
      "backend-ref": "",
      "debug-log-path": "",
      status: "running",
      "last-activity-at": "2024-06-01T12:00:00Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a session ref whose session name is the internal sentinel", () => {
    const result = conversationRefAttrsSchema.safeParse({
      "project-name": "my-app",
      "project-path": "/repos/my-app",
      scope: "session",
      "session-name": "__project__",
      "worktree-path": "/repos/my-app",
      "conversation-id": "conv-1",
      "conversation-name": "",
      backend: "claude",
      "backend-ref": "",
      "debug-log-path": "",
      status: "running",
      "last-activity-at": "2024-06-01T12:00:00Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a session ref with an empty session name", () => {
    const result = conversationRefAttrsSchema.safeParse({
      "project-name": "my-app",
      "project-path": "/repos/my-app",
      scope: "session",
      "session-name": "",
      "worktree-path": "/repos/my-app",
      "conversation-id": "conv-1",
      "conversation-name": "",
      backend: "claude",
      "backend-ref": "",
      "debug-log-path": "",
      status: "running",
      "last-activity-at": "2024-06-01T12:00:00Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a ref with no scope attribute rather than assuming session scope", () => {
    // Tolerating the omission would be an unapproved compatibility shim, and
    // would reintroduce exactly the defect D1 closes: an absent discriminator
    // silently read as session scope.
    const result = conversationRefAttrsSchema.safeParse({
      "project-name": "my-app",
      "project-path": "/repos/my-app",
      "session-name": "main",
      "worktree-path": "/repos/my-app/.worktrees/main",
      "conversation-id": "conv-123",
      "conversation-name": "Refactor parser",
      backend: "claude",
      "backend-ref": "",
      "debug-log-path": "",
      status: "running",
      "last-activity-at": "2024-06-01T12:00:00Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("buildConversationRefXmlFromListItem", () => {
  it("emits the canonical conversation-ref XML without compaction", () => {
    expect(buildConversationRefXmlFromListItem(listItem())).toBe(
      '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
        'scope="session" ' +
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
      scope: "session" as const,
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

  it("maps a project list item onto the project variant, with no sessionName key", () => {
    const attrs = conversationListItemToMentionAttrs({
      projectName: "my-app",
      projectPath: "/repos/my-app",
      scope: "project",
      worktreePath: "/repos/my-app",
      conversationId: "conv-p1",
      conversationName: "Project chat",
      summary: null,
      firstPromptSnippet: null,
      backend: "claude",
      backendRef: null,
      transcriptPath: null,
      debugLogPath: null,
      status: "running",
      lastActivityAt: "2024-06-01T12:00:00Z",
      archived: false,
    });

    expect(attrs.scope).toBe("project");
    expect(attrs).not.toHaveProperty("sessionName");
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
