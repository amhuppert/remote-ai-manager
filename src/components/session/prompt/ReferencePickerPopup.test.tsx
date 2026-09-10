// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  AllConversationsResponse,
  ConversationListItem,
  SessionConversationListItem,
} from "@/lib/conversations/schemas";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import type { SpecPickerSpec } from "@/lib/prompt-editor/reference-registry";
import type { PickerTrigger } from "@/lib/prompt-editor/reference-picker";
import type { TicketListItem } from "@/lib/tickets/schemas";
import {
  createReferencePickerPopup,
  type ReferencePickerPopupHandle,
} from "./ReferencePickerPopup";

function conversation(
  overrides: Partial<SessionConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "alpha",
    projectPath: "/repos/alpha",
    scope: "session" as const,
    sessionName: overrides.sessionName ?? "main",
    worktreePath: "/repos/alpha/.worktrees/main",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? "Auth token refresh review",
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status: overrides.status ?? "running",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
    compactArtifactId: undefined,
    compactStatus: undefined,
    compactCoveredSeq: undefined,
    compactCreatedAt: undefined,
  };
}

function ticket(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath: "/repos/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 142,
    title: overrides.title ?? "Redesign prompt autocomplete",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "in_progress",
    attachmentCount: overrides.attachmentCount ?? 3,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const SPEC: SpecPickerSpec = {
  projectName: "alpha",
  specId: "spec-1",
  slug: "prompt-autocomplete",
  name: "Prompt input reference picker",
  revision: 4,
  elements: [
    {
      type: "requirement",
      elementId: "r1",
      handle: "R1",
      name: "Unified popup shell",
      searchText: "Unified popup shell",
    },
    {
      type: "task",
      elementId: "t1",
      handle: "T1",
      name: "Extract shared picker shell",
      searchText: "Extract shared picker shell",
    },
  ],
};

function notepadItem(
  overrides: Partial<NotepadListItem> & { id: string },
): NotepadListItem {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "project",
    projectPath: overrides.projectPath ?? "/repos/alpha",
    projectName: overrides.projectName ?? "alpha",
    name: overrides.name ?? "Release checklist",
    revision: overrides.revision ?? 3,
    writeMode: overrides.writeMode ?? "full-edit",
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const idle = { isLoading: false, isError: false, error: null } as const;

import type { ExecutionReferenceItem } from "@/lib/workflow-graph/references";

interface RenderOptions {
  executions?: ExecutionReferenceItem[];
  trigger?: PickerTrigger;
  query?: string;
  files?: { path: string }[];
  conversations?: ConversationListItem[];
  tickets?: TicketListItem[];
  specs?: SpecPickerSpec[];
  notepads?: NotepadListItem[];
  sessionScoped?: boolean;
}

function renderPicker(options: RenderOptions = {}) {
  const conversations: AllConversationsResponse = {
    items: options.conversations ?? [conversation({ conversationId: "c1" })],
    totalCount: 1,
  };
  const useAllConversations = vi.fn(() => ({ data: conversations, ...idle }));
  const Popup = createReferencePickerPopup({
    useAllConversations,
    useTickets: () => ({
      data: options.tickets ?? [ticket({ id: "t1" })],
      ...idle,
    }),
    useSpecs: () => ({ data: options.specs ?? [SPEC], ...idle }),
    useFiles: () => ({
      data: { items: options.files ?? [{ path: "src/lib/prompt.ts" }] },
      ...idle,
    }),
    useExecutions: (query) => ({
      data: (options.executions ?? []).filter((item) =>
        item.title.toLowerCase().includes(query.toLowerCase()),
      ),
      ...idle,
    }),
    useNotepads: () => ({
      data: options.notepads ?? [notepadItem({ id: "np-7f3a" })],
      ...idle,
    }),
  });
  const ref = createRef<ReferencePickerPopupHandle>();
  const onSelect = vi.fn();
  const onComplete = vi.fn();
  const onClose = vi.fn();
  render(
    <Popup
      ref={ref}
      trigger={options.trigger ?? "#"}
      query={options.query ?? ""}
      currentProjectName="alpha"
      scopeRef={
        options.sessionScoped === false
          ? { scope: "project" }
          : { scope: "session", sessionName: "main" }
      }
      currentConversationId={null}
      onSelect={onSelect}
      onComplete={onComplete}
      isCaretAtQueryEnd={() => true}
      onClose={onClose}
    />,
  );
  return { ref, onSelect, onComplete, onClose, useAllConversations };
}

function press(
  ref: React.RefObject<ReferencePickerPopupHandle | null>,
  init: KeyboardEventInit & { key: string },
): boolean {
  let handled = false;
  act(() => {
    handled =
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { cancelable: true, ...init }),
      ) ?? false;
  });
  return handled;
}

function rowNames(): string[] {
  return screen.getAllByRole("row").map((row) => row.textContent ?? "");
}

describe("ReferencePickerPopup", () => {
  it("searches executions through the shared abbreviated scope grammar and inserts the exact run", () => {
    const { ref, onSelect } = renderPicker({
      query: "exec: Capture",
      executions: [
        {
          projectName: "alpha",
          sessionName: "release",
          executionId: "run-past",
          title: "Capture delivery",
          status: "completed",
          startedAt: "2026-09-10T00:00:00Z",
        },
      ],
    });
    expect(
      screen.getByRole("button", { name: "Executions (1)" }),
    ).toHaveAttribute("aria-pressed", "true");
    press(ref, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reference",
        type: "execution",
        attrs: expect.objectContaining({
          "execution-id": "run-past",
          "session-name": "release",
        }),
      }),
    );
  });
  it("opens on the scope its trigger preselects", () => {
    renderPicker({ trigger: "!" });

    expect(screen.getByText("! reference — tickets")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Tickets/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers every kind under the All scope with counts per tab", () => {
    renderPicker({ trigger: "#" });

    expect(screen.getByText("# reference — all types")).toBeVisible();
    for (const label of [
      "Files",
      "Conversations",
      "Specs",
      "Tickets",
      "Notepads",
    ]) {
      expect(screen.getByRole("rowgroup", { name: label })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "All (5)" })).toBeVisible();
  });

  it("offers notepads and inserts a notepad chip when one is selected", () => {
    const { ref, onSelect } = renderPicker({
      trigger: "#",
      notepads: [notepadItem({ id: "np-7f3a", name: "Release checklist" })],
    });

    act(() => {
      screen.getByRole("button", { name: /^Notepads/ }).click();
    });
    expect(
      within(screen.getByRole("rowgroup", { name: "Notepads" })).getByText(
        "Release checklist",
      ),
    ).toBeVisible();

    press(ref, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith({
      kind: "reference",
      type: "notepad",
      attrs: {
        notepadId: "np-7f3a",
        name: "Release checklist",
        scope: "project",
        projectName: "alpha",
      },
    });
  });

  it("cycles scope with Tab and back with Shift+Tab", () => {
    const { ref } = renderPicker({ trigger: "#" });

    expect(press(ref, { key: "Tab" })).toBe(true);
    expect(screen.getByText("# reference — files")).toBeVisible();

    press(ref, { key: "Tab" });
    expect(screen.getByText("# reference — conversations")).toBeVisible();

    press(ref, { key: "Tab", shiftKey: true });
    expect(screen.getByText("# reference — files")).toBeVisible();
  });

  it("switches scope when a tab is clicked", () => {
    renderPicker({ trigger: "#" });

    act(() => {
      screen.getByRole("button", { name: /^Tickets/ }).click();
    });

    expect(screen.getByText("# reference — tickets")).toBeVisible();
  });

  it("selects the active row and reports what to insert", () => {
    const { ref, onSelect } = renderPicker({ trigger: "!" });

    press(ref, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith({
      kind: "reference",
      type: "ticket",
      attrs: {
        projectName: "alpha",
        ticketNumber: "142",
        identifier: "alpha#142",
        title: "Redesign prompt autocomplete",
      },
    });
  });

  it("selects a file from a trigger that did not preselect files", () => {
    const { ref, onSelect } = renderPicker({ trigger: "!" });

    act(() => {
      screen.getByRole("button", { name: /^Files/ }).click();
    });
    press(ref, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith({
      kind: "file",
      path: "src/lib/prompt.ts",
      basename: "prompt.ts",
      ext: "ts",
    });
  });

  it("completes the active row's text with ArrowRight without selecting", () => {
    const { ref, onComplete, onSelect } = renderPicker({
      trigger: "!",
      query: "red",
    });

    expect(press(ref, { key: "ArrowRight" })).toBe(true);
    expect(onComplete).toHaveBeenCalledWith("alpha#142");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves ArrowRight to the caret when it is not at the query end", () => {
    const ref = createRef<ReferencePickerPopupHandle>();
    const Popup = createReferencePickerPopup({
      useAllConversations: () => ({
        data: { items: [], totalCount: 0 },
        ...idle,
      }),
      useTickets: () => ({ data: [ticket({ id: "t1" })], ...idle }),
      useSpecs: () => ({ data: [], ...idle }),
      useFiles: () => ({ data: { items: [] }, ...idle }),
      useExecutions: () => ({ data: [], ...idle }),
      useNotepads: () => ({ data: [], ...idle }),
    });
    const onComplete = vi.fn();
    render(
      <Popup
        ref={ref}
        trigger="!"
        query="red"
        currentProjectName="alpha"
        scopeRef={{ scope: "session", sessionName: "main" }}
        currentConversationId={null}
        onSelect={vi.fn()}
        onComplete={onComplete}
        isCaretAtQueryEnd={() => false}
      />,
    );

    expect(press(ref, { key: "ArrowRight" })).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("reveals finished tickets with Alt+D and dims them", () => {
    const tickets = [
      ticket({ id: "live", title: "Match live", status: "in_progress" }),
      ticket({ id: "done", title: "Match shipped", status: "done" }),
    ];
    const { ref } = renderPicker({ trigger: "!", tickets });

    expect(rowNames()).toHaveLength(1);
    const chip = screen.getByRole("button", { name: /\+1 done/ });
    expect(chip).toHaveAttribute("aria-pressed", "false");

    press(ref, { key: "d", code: "KeyD", altKey: true });

    expect(rowNames()).toHaveLength(2);
    expect(screen.getByRole("button", { name: /incl\. done/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(screen.getByRole("row", { name: /Match shipped/ })).getByRole(
        "gridcell",
        { name: /Match shipped/ },
      ),
    ).toHaveClass("opacity-55");
  });

  it("toggles the done filter from its header chip", () => {
    const tickets = [
      ticket({ id: "live", title: "Match live", status: "in_progress" }),
      ticket({ id: "done", title: "Match shipped", status: "done" }),
    ];
    renderPicker({ trigger: "!", tickets });

    act(() => {
      screen.getByRole("button", { name: /\+1 done/ }).click();
    });

    expect(rowNames()).toHaveLength(2);
  });

  it("reveals archived conversations with Alt+A", () => {
    const conversations = [
      conversation({ conversationId: "live" }),
      conversation({
        conversationId: "old",
        conversationName: "Auth token archive spike",
        archived: true,
      }),
    ];
    const { ref, useAllConversations } = renderPicker({
      trigger: "#",
      conversations,
      files: [],
      specs: [],
      tickets: [],
      notepads: [],
    });

    expect(rowNames()).toHaveLength(1);
    press(ref, { key: "a", code: "KeyA", altKey: true });
    expect(rowNames()).toHaveLength(2);
    // Archived rows are filtered locally, so the fetch never changes shape.
    expect(useAllConversations).toHaveBeenLastCalledWith({
      includeArchived: true,
    });
  });

  it("jumps to a scope from its +N more row", () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      path: `src/file-${index}.ts`,
    }));
    const { ref } = renderPicker({ trigger: "#", files });

    const more = screen.getByRole("row", { name: /\+3 more in Files/ });
    expect(more).toBeVisible();

    act(() => {
      more.click();
    });

    expect(screen.getByText("# reference — files")).toBeVisible();
    expect(rowNames()).toHaveLength(7);
    expect(press(ref, { key: "Escape" })).toBe(true);
  });

  it("drills into a spec's elements and narrows them by element kind", () => {
    const { ref } = renderPicker({
      trigger: "#",
      query: "prompt-autocomplete/",
    });

    expect(
      screen.getByText("# spec — prompt-autocomplete · rev 4"),
    ).toBeVisible();
    expect(
      screen.getByRole("rowgroup", { name: "Requirements" }),
    ).toBeVisible();
    expect(screen.getByRole("rowgroup", { name: "Tasks" })).toBeVisible();

    press(ref, { key: "Tab" });

    expect(screen.queryByRole("rowgroup", { name: "Tasks" })).toBeNull();
    expect(
      screen.getByRole("row", { name: /Unified popup shell/ }),
    ).toBeVisible();
  });

  it("offers the Markdown viewer for a markdown file in a session worktree", () => {
    renderPicker({
      trigger: "@",
      files: [{ path: "docs/report.md" }, { path: "src/lib/prompt.ts" }],
    });

    expect(
      screen.getByRole("button", {
        name: "Open docs/report.md in Markdown viewer",
      }),
    ).toBeVisible();
  });

  it("withholds the Markdown viewer from a project conversation", () => {
    renderPicker({
      trigger: "@",
      files: [{ path: "docs/report.md" }],
      sessionScoped: false,
    });

    expect(
      screen.queryByRole("button", { name: /Markdown viewer/ }),
    ).toBeNull();
  });

  it("shows the rows that arrived while another source is still loading", () => {
    const Popup = createReferencePickerPopup({
      useAllConversations: () => ({
        data: undefined,
        isLoading: true,
        isError: false,
        error: null,
      }),
      useTickets: () => ({ data: [ticket({ id: "t1" })], ...idle }),
      useSpecs: () => ({ data: [], ...idle }),
      useFiles: () => ({ data: { items: [] }, ...idle }),
      useExecutions: () => ({ data: [], ...idle }),
      useNotepads: () => ({ data: [], ...idle }),
    });
    render(
      <Popup
        trigger="!"
        query=""
        currentProjectName="alpha"
        scopeRef={{ scope: "session", sessionName: "main" }}
        currentConversationId={null}
        onSelect={vi.fn()}
        onComplete={vi.fn()}
        isCaretAtQueryEnd={() => true}
      />,
    );

    expect(screen.queryByText("Loading references...")).toBeNull();
    expect(
      screen.getByRole("row", { name: /Redesign prompt autocomplete/ }),
    ).toBeVisible();
  });

  it("surfaces a source failure only when nothing else matched", () => {
    const failing = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: "specs exploded" },
    };
    const Popup = createReferencePickerPopup({
      useAllConversations: () => ({
        data: { items: [], totalCount: 0 },
        ...idle,
      }),
      useTickets: () => ({ data: [], ...idle }),
      useSpecs: () => failing,
      useFiles: () => ({ data: { items: [] }, ...idle }),
      useExecutions: () => ({ data: [], ...idle }),
      useNotepads: () => ({ data: [], ...idle }),
    });
    render(
      <Popup
        trigger="#"
        query=""
        currentProjectName="alpha"
        scopeRef={{ scope: "session", sessionName: "main" }}
        currentConversationId={null}
        onSelect={vi.fn()}
        onComplete={vi.fn()}
        isCaretAtQueryEnd={() => true}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("specs exploded");
  });

  it("closes on Escape", () => {
    const { ref, onClose } = renderPicker();

    expect(press(ref, { key: "Escape" })).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
