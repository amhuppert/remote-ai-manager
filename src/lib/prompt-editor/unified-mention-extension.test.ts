// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import type { TicketListItem } from "@/lib/tickets/schemas";
import { ConversationMentionNode } from "./conversation-mention-node";
import { MessageMentionNode } from "./message-mention-node";
import type {
  ReferencePickerContext,
  ReferencePickerItem,
  SpecPickerSpec,
} from "./reference-registry";
import {
  DecisionMentionNode,
  RequirementMentionNode,
  SpecMentionNode,
  TaskMentionNode,
} from "./spec-mention-nodes";
import { TicketMentionNode } from "./ticket-mention-node";
import {
  UnifiedMention,
  getUnifiedMentionGroups,
} from "./unified-mention-extension";

beforeEach(() => {
  Range.prototype.getClientRects ??= () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

function conversation(
  overrides: Partial<ConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "alpha",
    projectPath: overrides.projectPath ?? "/repos/alpha",
    sessionName: overrides.sessionName ?? "main",
    worktreePath: overrides.worktreePath ?? "/repos/alpha/.worktrees/main",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? "Authentication review",
    summary: overrides.summary ?? null,
    firstPromptSnippet: overrides.firstPromptSnippet ?? null,
    backend: overrides.backend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    debugLogPath: overrides.debugLogPath ?? null,
    status: overrides.status ?? "awaiting",
    lastActivityAt: overrides.lastActivityAt ?? "2026-07-01T00:00:00Z",
    archived: overrides.archived ?? false,
    compactArtifactId: overrides.compactArtifactId,
    compactStatus: overrides.compactStatus,
    compactCoveredSeq: overrides.compactCoveredSeq,
    compactCreatedAt: overrides.compactCreatedAt,
  };
}

function ticket(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/repos/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 12,
    title: overrides.title ?? "Authentication hardening",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "not_started",
    attachmentCount: overrides.attachmentCount ?? 0,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

const context: ReferencePickerContext = {
  currentProjectName: "alpha",
  currentConversationId: "self",
  conversations: [
    conversation({ conversationId: "self", conversationName: "Current" }),
    conversation({ conversationId: "conv-auth" }),
  ],
  tickets: [ticket({ id: "ticket-auth" })],
  specs: [],
  selectedSpec: null,
};

function spec(overrides: Partial<SpecPickerSpec> = {}): SpecPickerSpec {
  return {
    projectName: overrides.projectName ?? "alpha",
    specId: overrides.specId ?? "spec-native-sdd",
    slug: overrides.slug ?? "native-sdd",
    name: overrides.name ?? "Native SDD",
    revision: overrides.revision ?? 4,
    elements: overrides.elements ?? [
      {
        type: "requirement",
        elementId: "requirement-5",
        handle: "R5",
        name: "References stay addressable",
        searchText: "References stay addressable across approval revisions",
      },
      {
        type: "decision",
        elementId: "decision-2",
        handle: "D2",
        name: "Immutable snapshots",
        searchText: "Approval revisions use immutable snapshots",
      },
      {
        type: "task",
        elementId: "task-15",
        handle: "T15",
        name: "Build unified picker",
        searchText: "Build unified picker and approval chips",
      },
    ],
  };
}

describe("getUnifiedMentionGroups", () => {
  it("returns non-empty registered picker sources as ordered groups", () => {
    const groups = getUnifiedMentionGroups("auth", context);

    expect(groups.map((group) => group.type)).toEqual([
      "conversation",
      "ticket",
    ]);
    expect(groups[0]?.items[0]).toMatchObject({
      type: "conversation",
      label: "Authentication review",
      attrs: { conversationId: "conv-auth" },
    });
    expect(groups[1]?.items[0]).toMatchObject({
      type: "ticket",
      label: "alpha#12",
      attrs: { identifier: "alpha#12" },
    });
  });

  it("narrows to one registered type and applies the remaining query", () => {
    const groups = getUnifiedMentionGroups("tickets: hard", context);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      type: "ticket",
      label: "Tickets",
    });
    expect(groups[0]?.items.map((item) => item.label)).toEqual(["alpha#12"]);
  });

  it("preserves conversation compaction metadata in the insertion attributes", () => {
    const groups = getUnifiedMentionGroups("", {
      ...context,
      conversations: [
        conversation({
          conversationId: "compacted",
          compactArtifactId: "artifact-1",
          compactStatus: "fresh",
          compactCoveredSeq: "0..42",
          compactCreatedAt: "2026-07-02T00:00:00Z",
        }),
      ],
    });

    expect(groups[0]?.items[0]?.attrs).toMatchObject({
      compactArtifactId: "artifact-1",
      compactStatus: "fresh",
      compactCoveredSeq: "0..42",
      compactCreatedAt: "2026-07-02T00:00:00Z",
    });
  });

  it("matches specs by slug or name and orders the current project first", () => {
    const groups = getUnifiedMentionGroups("native", {
      ...context,
      specs: [
        spec({
          projectName: "beta",
          specId: "spec-beta",
          name: "Native Delivery",
        }),
        spec({
          projectName: "alpha",
          specId: "spec-alpha",
          name: "Contract authoring",
        }),
      ],
    });

    expect(groups.map((group) => group.type)).toEqual(["spec"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      "spec:alpha:spec-alpha",
      "spec:beta:spec-beta",
    ]);
    expect(groups[0]?.items[0]).toMatchObject({
      label: "Contract authoring",
      description: "native-sdd · alpha",
      attrs: {
        projectName: "alpha",
        slug: "native-sdd",
        name: "Contract authoring",
        revision: "4",
      },
    });
  });

  it("drills into one spec and matches each element kind by handle and text", () => {
    const groups = getUnifiedMentionGroups("native-sdd/approval", {
      ...context,
      specs: [spec()],
    });

    expect(groups.map((group) => group.type)).toEqual([
      "requirement",
      "decision",
      "task",
    ]);
    expect(groups.map((group) => group.items[0]?.label)).toEqual([
      "native-sdd/R5",
      "native-sdd/D2",
      "native-sdd/T15",
    ]);
    expect(groups[0]?.items[0]?.attrs).toMatchObject({
      projectName: "alpha",
      slug: "native-sdd",
      handle: "R5",
      name: "References stay addressable",
      revision: "4",
    });
  });

  it("matches a drill-in element by its bare handle", () => {
    const groups = getUnifiedMentionGroups("native-sdd/D2", {
      ...context,
      specs: [spec()],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("decision");
    expect(groups[0]?.items[0]?.description).toBe("Immutable snapshots");
  });

  it("drills into question and assumption records alongside R/D/T elements", () => {
    const withRecords = spec({
      elements: [
        ...spec().elements,
        {
          type: "question",
          elementId: "question-2",
          handle: "Q2",
          name: "Which retention period applies?",
          searchText: "Which retention period applies?",
        },
        {
          type: "assumption",
          elementId: "assumption-1",
          handle: "A1",
          name: "SQLite remains authoritative",
          searchText: "SQLite remains authoritative",
        },
      ],
    });

    const groups = getUnifiedMentionGroups("native-sdd/", {
      ...context,
      specs: [withRecords],
    });
    expect(groups.map((group) => group.type)).toEqual([
      "requirement",
      "decision",
      "task",
      "question",
      "assumption",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Requirements",
      "Decisions",
      "Tasks",
      "Questions",
      "Assumptions",
    ]);

    const byHandle = getUnifiedMentionGroups("native-sdd/Q2", {
      ...context,
      specs: [withRecords],
    });
    expect(byHandle).toHaveLength(1);
    expect(byHandle[0]?.type).toBe("question");
    expect(byHandle[0]?.items[0]).toMatchObject({
      label: "native-sdd/Q2",
      attrs: {
        slug: "native-sdd",
        handle: "Q2",
        name: "Which retention period applies?",
        revision: "4",
        readCommand: "cctl spec get 'native-sdd/Q2' --project 'alpha'",
      },
    });
  });
});

describe("UnifiedMention extension", () => {
  it.each([
    {
      type: "conversation" as const,
      nodeName: "conversationMention",
      attrs: {
        projectName: "alpha",
        projectPath: "/repos/alpha",
        sessionName: "main",
        worktreePath: "/repos/alpha/.worktrees/main",
        conversationId: "conv-auth",
        conversationName: "Authentication review",
        backend: "claude",
        backendRef: "",
        transcriptPath: "",
        debugLogPath: "",
        status: "awaiting",
        lastActivityAt: "2026-07-01T00:00:00Z",
        compactArtifactId: "",
        compactStatus: "none",
        compactCoveredSeq: "",
        compactCreatedAt: "",
      },
    },
    {
      type: "ticket" as const,
      nodeName: "ticketMention",
      attrs: {
        projectName: "alpha",
        ticketNumber: "12",
        identifier: "alpha#12",
        title: "Authentication hardening",
      },
    },
    {
      type: "message" as const,
      nodeName: "messageMention",
      attrs: {
        projectName: "alpha",
        sessionName: "main",
        conversationId: "conv-auth",
        conversationName: "Authentication review",
        messageIndex: "5",
        role: "assistant",
        timestamp: "",
        model: "",
        compacted: "false",
        compactArtifactId: "",
        compactCreatedAt: "",
      },
    },
    {
      type: "spec" as const,
      nodeName: "specMention",
      attrs: {
        projectName: "alpha",
        slug: "native-sdd",
        name: "Native SDD",
        revision: "4",
        readCommand: "cctl spec show 'native-sdd' --project 'alpha'",
      },
    },
    {
      type: "requirement" as const,
      nodeName: "requirementMention",
      attrs: {
        projectName: "alpha",
        slug: "native-sdd",
        handle: "R5",
        name: "References stay addressable",
        revision: "4",
        readCommand: "cctl spec get 'native-sdd/R5' --project 'alpha'",
      },
    },
    {
      type: "decision" as const,
      nodeName: "decisionMention",
      attrs: {
        projectName: "alpha",
        slug: "native-sdd",
        handle: "D2",
        name: "Immutable snapshots",
        revision: "4",
        readCommand: "cctl spec get 'native-sdd/D2' --project 'alpha'",
      },
    },
    {
      type: "task" as const,
      nodeName: "taskMention",
      attrs: {
        projectName: "alpha",
        slug: "native-sdd",
        handle: "T15",
        name: "Build unified picker",
        revision: "4",
        readCommand: "cctl spec get 'native-sdd/T15' --project 'alpha'",
      },
    },
  ])(
    "inserts a selected $type item with unchanged node attributes",
    async (fixture) => {
      const commandRef: {
        current: ((item: ReferencePickerItem) => void) | null;
      } = { current: null };
      const editor = new Editor({
        element: document.createElement("div"),
        extensions: [
          StarterKit,
          ConversationMentionNode,
          MessageMentionNode,
          TicketMentionNode,
          SpecMentionNode,
          RequirementMentionNode,
          DecisionMentionNode,
          TaskMentionNode,
          UnifiedMention.configure({
            items: () => [],
            render: () => ({
              onStart: (props) => {
                commandRef.current = props.command;
              },
            }),
          }),
        ],
        content: "<p></p>",
      });

      editor.chain().insertContent("#").run();
      await Promise.resolve();
      expect(commandRef.current).not.toBeNull();

      commandRef.current?.({
        type: fixture.type,
        id: `${fixture.type}:fixture`,
        label: "Fixture",
        description: "",
        matchIndices: [],
        attrs: fixture.attrs,
      });

      const mention = editor.state.doc.firstChild?.firstChild;
      expect(mention?.type.name).toBe(fixture.nodeName);
      expect(mention?.attrs).toMatchObject(fixture.attrs);
      expect(editor.state.doc.firstChild?.child(1).text).toBe(" ");
      editor.destroy();
    },
  );
});
