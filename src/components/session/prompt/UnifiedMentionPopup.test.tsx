// @vitest-environment jsdom
import type { SessionConversationListItem } from "@/lib/conversations/schemas";
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  AllConversationsResponse,
  ConversationListItem,
} from "@/lib/conversations/schemas";
import type { TicketListItem } from "@/lib/tickets/schemas";
import type { SpecPickerSpec } from "@/lib/prompt-editor/reference-registry";
import { getUnifiedMentionGroups } from "@/lib/prompt-editor/unified-mention-extension";
import type { SpecDetailView, SpecSummaryView } from "@/lib/specs/queries";
import {
  createUnifiedMentionPopup,
  toSpecPickerSpec,
  type UnifiedMentionPopupHandle,
} from "./UnifiedMentionPopup";

const SPEC_TIMESTAMP = "2026-07-18T00:00:00.000Z";

function specSummary(revisionNumber: number): SpecSummaryView {
  return {
    spec: {
      id: "spec-native-sdd",
      projectPath: "/repos/alpha",
      slug: "native-sdd",
      name: "Native SDD",
      gatePolicy: { preset: "contract-bearing" },
      abandonedAt: null,
      abandonedReason: null,
      createdAt: SPEC_TIMESTAMP,
      updatedAt: SPEC_TIMESTAMP,
    },
    phase: { primary: "draft" },
    currentRevision: {
      id: `revision-${revisionNumber}`,
      specId: "spec-native-sdd",
      number: revisionNumber,
      state: "draft",
      authoringStage: "requirements",
      basedOnRevisionId: null,
      contentHash: null,
      proposedAt: null,
      approvedAt: null,
      createdAt: SPEC_TIMESTAMP,
    },
    counts: { requirements: 1, criteria: 0, decisions: 0, tasks: 0 },
    pendingApprovalCount: 0,
    approvalState: "pending",
    delivery: { allWaived: false, provenCount: 0, totalInScope: 0 },
    linkedWork: {
      tickets: 0,
      conversations: 0,
      sessions: 0,
      workflowExecutions: 0,
      mergeJobs: 0,
    },
  };
}

function specDetail(revisionNumber: number, statement: string): SpecDetailView {
  const summary = specSummary(revisionNumber);
  const revision = summary.currentRevision!;
  return {
    spec: summary.spec,
    aliases: [],
    revisions: [revision],
    baseRevision: null,
    currentRevision: {
      revision,
      elements: [
        {
          element: {
            id: "requirement-5",
            specId: summary.spec.id,
            kind: "requirement",
            number: 5,
            parentElementId: null,
            createdAt: SPEC_TIMESTAMP,
          },
          version: {
            revisionId: revision.id,
            elementId: "requirement-5",
            position: 0,
            payload: {
              kind: "requirement",
              statement,
              priority: "must",
              risk: "medium",
            },
            payloadHash: `hash-${revisionNumber}`,
            elementVersion: revisionNumber,
            createdAt: SPEC_TIMESTAMP,
            updatedAt: SPEC_TIMESTAMP,
          },
        },
      ],
    },
    currentApprovedRevision: null,
    executionRevisionSnapshots: [],
    approvals: [],
    comments: [],
    executions: [],
    criterionDispositions: [],
    waivers: [],
    gateAdmissions: [],
    linkedTickets: [],
    elementStatuses: {
      requirements: [
        {
          elementId: "requirement-5",
          status: {
            approval: "unapproved",
            coverage: "uncovered",
            proof: "pending",
          },
        },
      ],
      tasks: [],
    },
    status: {
      specId: summary.spec.id,
      slug: summary.spec.slug,
      phase: summary.phase,
      executions: [],
      gates: [],
      authoringSequence: null,
      pendingApprovals: [],
      openQuestions: [],
      assumptions: [],
      taskPlan: [],
      coverage: { coveredCriteria: 0, totalCriteria: 0, percentage: 0 },
      delivery: { allWaived: false, provenCount: 0, totalInScope: 0 },
    },
    questions: [],
    assumptions: [],
  };
}

function conversation(
  overrides: Partial<SessionConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "alpha",
    projectPath: overrides.projectPath ?? "/repos/alpha",
    scope: "session" as const,
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

function renderPopup(query = "auth") {
  const conversations: AllConversationsResponse = {
    items: [
      conversation({ conversationId: "self", conversationName: "Current" }),
      conversation({ conversationId: "conv-auth" }),
    ],
    totalCount: 2,
  };
  const useAllConversations = vi.fn(() => ({
    data: conversations,
    isLoading: false,
    isError: false,
    error: null,
  }));
  const Popup = createUnifiedMentionPopup({
    useAllConversations,
    useTickets: () => ({
      data: [ticket({ id: "ticket-auth" })],
      isLoading: false,
      isError: false,
      error: null,
    }),
    useSpecs: () => ({
      data: [
        {
          projectName: "alpha",
          specId: "spec-native-sdd",
          slug: "native-sdd",
          name: "Authentication specification",
          revision: 4,
          elements: [
            {
              type: "requirement",
              elementId: "requirement-5",
              handle: "R5",
              name: "References stay addressable",
              searchText: "References stay addressable across revisions",
            },
            {
              type: "decision",
              elementId: "decision-2",
              handle: "D2",
              name: "Immutable snapshots",
              searchText: "Immutable snapshots preserve approval state",
            },
            {
              type: "task",
              elementId: "task-15",
              handle: "T15",
              name: "Build unified picker",
              searchText: "Build unified picker",
            },
          ],
        } satisfies SpecPickerSpec,
      ],
      isLoading: false,
      isError: false,
      error: null,
    }),
  });
  const ref = createRef<UnifiedMentionPopupHandle>();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <Popup
      ref={ref}
      query={query}
      currentProjectName="alpha"
      currentConversationId="self"
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { ref, onSelect, onClose, useAllConversations };
}

describe("UnifiedMentionPopup", () => {
  it("renders one grouped picker and excludes the current conversation", () => {
    renderPopup();

    expect(screen.getByText("# reference — all types")).toBeVisible();
    expect(screen.getByRole("group", { name: "Conversations" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Tickets" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Specs" })).toBeVisible();
    expect(
      screen.getByRole("option", { name: /Authentication review/ }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /alpha#12/ })).toBeVisible();
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Conversations", "Specs", "Tickets"]);
  });

  it("renders slug-qualified drill-in results grouped by element kind", () => {
    renderPopup("native-sdd/");

    expect(
      screen.getByText("native-sdd — requirements · decisions · tasks"),
    ).toBeVisible();
    expect(screen.getByText("Matched on handle + text")).toBeVisible();
    expect(screen.getByRole("group", { name: "Requirements" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Decisions" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Tasks" })).toBeVisible();
    expect(
      screen.getByRole("option", { name: /native-sdd\/R5/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /native-sdd\/D2/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /native-sdd\/T15/ }),
    ).toBeVisible();
  });

  it("binds drill-in content to the detail revision while caches refetch", () => {
    const inventorySummary = specSummary(5);
    const cachedDetail = specDetail(4, "Statement from revision four");
    const cachedSpec = toSpecPickerSpec(
      "alpha",
      inventorySummary,
      cachedDetail,
    );
    const context = {
      currentProjectName: "alpha",
      currentConversationId: null,
      conversations: [],
      tickets: [],
      specs: [cachedSpec],
      selectedSpec: null,
    };

    const cachedItem = getUnifiedMentionGroups("native-sdd/", context).flatMap(
      (group) => group.items,
    )[0];

    expect(cachedItem?.attrs).toEqual(
      expect.objectContaining({
        name: "Statement from revision four",
        revision: "4",
      }),
    );

    const refetchedSpec = toSpecPickerSpec(
      "alpha",
      inventorySummary,
      specDetail(5, "Statement from revision five"),
    );
    const refetchedItem = getUnifiedMentionGroups("native-sdd/", {
      ...context,
      specs: [refetchedSpec],
    }).flatMap((group) => group.items)[0];

    expect(refetchedItem?.attrs).toEqual(
      expect.objectContaining({
        name: "Statement from revision five",
        revision: "5",
      }),
    );
  });

  it("emits question and assumption drill-in items from the detail view", () => {
    const detail: SpecDetailView = {
      ...specDetail(4, "Statement from revision four"),
      questions: [
        {
          id: "question-2",
          number: 2,
          handle: "Q2",
          elementId: null,
          text: "Which retention period applies?",
          status: "open",
          answer: null,
          answeredAt: null,
          provenance: { kind: "agent", conversationId: "conv-1" },
          createdAt: SPEC_TIMESTAMP,
          updatedAt: SPEC_TIMESTAMP,
        },
      ],
      assumptions: [
        {
          id: "assumption-1",
          number: 1,
          handle: "A1",
          elementId: null,
          text: "SQLite remains authoritative",
          disposition: "proposed",
          disposedAt: null,
          proposedBy: { kind: "agent", conversationId: "conv-1" },
          createdAt: SPEC_TIMESTAMP,
          updatedAt: SPEC_TIMESTAMP,
        },
      ],
    };
    const pickerSpec = toSpecPickerSpec("alpha", specSummary(4), detail);
    const groups = getUnifiedMentionGroups("native-sdd/", {
      currentProjectName: "alpha",
      currentConversationId: null,
      conversations: [],
      tickets: [],
      specs: [pickerSpec],
      selectedSpec: null,
    });

    expect(groups.map((group) => group.type)).toEqual([
      "requirement",
      "question",
      "assumption",
    ]);
    expect(
      groups
        .find((group) => group.type === "question")
        ?.items.map((item) => item.label),
    ).toEqual(["native-sdd/Q2"]);
    expect(
      groups.find((group) => group.type === "assumption")?.items[0],
    ).toMatchObject({
      label: "native-sdd/A1",
      description: "SQLite remains authoritative",
    });
  });

  it("renders only the requested type group for a type-filtered query", () => {
    renderPopup("tickets: hard");

    expect(screen.queryByRole("group", { name: "Conversations" })).toBeNull();
    expect(screen.getByRole("group", { name: "Tickets" })).toBeVisible();
  });

  it("navigates across groups and selects canonical registry attributes", () => {
    const { ref, onSelect } = renderPopup();

    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ticket",
        attrs: {
          projectName: "alpha",
          ticketNumber: "12",
          identifier: "alpha#12",
          title: "Authentication hardening",
        },
      }),
    );
  });

  it("retains the archived-conversation toggle and Escape close behavior", () => {
    const { ref, onClose, useAllConversations } = renderPopup();

    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "a", altKey: true }),
      );
    });
    expect(useAllConversations).toHaveBeenLastCalledWith({
      includeArchived: true,
    });

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    act(() => {
      expect(ref.current?.handleKeyDown(escape)).toBe(true);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
