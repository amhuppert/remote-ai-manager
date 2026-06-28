// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";

import {
  createConversationTargetPicker,
  type ConversationTargetPickerProps,
} from "./ConversationTargetPicker";
import { targetFromConversation } from "./use-conversation-target";
import type { ConversationTargetQuery } from "./use-conversation-target";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";

// Radix focuses content / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

function conv(
  overrides: Partial<ConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "proj-a",
    projectPath: overrides.projectPath ?? "/abs/proj-a",
    sessionName: overrides.sessionName ?? "sess-1",
    worktreePath: overrides.worktreePath ?? "/abs/proj-a/.worktrees/sess-1",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? null,
    summary: overrides.summary ?? null,
    firstPromptSnippet: overrides.firstPromptSnippet ?? null,
    backend: overrides.backend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    debugLogPath: overrides.debugLogPath ?? null,
    status: overrides.status ?? "awaiting",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
  };
}

const ITEMS: ConversationListItem[] = [
  conv({ conversationId: "alpha", conversationName: "Alpha review" }),
  conv({
    conversationId: "beta",
    conversationName: "Beta planning",
    projectName: "proj-b",
    projectPath: "/abs/proj-b",
    sessionName: "sess-2",
    backend: "codex",
    status: "running",
  }),
];

function makePicker(items: ConversationListItem[] = ITEMS) {
  const query: ConversationTargetQuery = {
    data: { items, totalCount: items.length },
    isLoading: false,
    isError: false,
  };
  return createConversationTargetPicker({ useAllConversations: () => query });
}

function renderPicker(
  props: Partial<ConversationTargetPickerProps> & {
    onSelect: (t: DocumentFeedbackTarget) => void;
  },
  items?: ConversationListItem[],
) {
  const Picker = makePicker(items);
  return render(
    <Picker
      target={props.target ?? null}
      onSelect={props.onSelect}
      defaultOpen
    />,
  );
}

describe("ConversationTargetPicker", () => {
  it("lists conversations across projects when opened", () => {
    renderPicker({ onSelect: vi.fn() });
    expect(screen.getByText("Alpha review")).toBeInTheDocument();
    expect(screen.getByText("Beta planning")).toBeInTheDocument();
  });

  it("emits the full routing identity when a conversation is chosen", () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    const option = screen.getByText("Beta planning").closest("[role=option]");
    expect(option).not.toBeNull();
    fireEvent.click(option!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      projectName: "proj-b",
      projectPath: "/abs/proj-b",
      sessionName: "sess-2",
      conversationId: "beta",
      backend: "codex",
      status: "running",
    } satisfies DocumentFeedbackTarget);
  });

  it("filters the list as the user searches", () => {
    renderPicker({ onSelect: vi.fn() });
    expect(screen.getAllByRole("option")).toHaveLength(2);

    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "beta" } });

    // A matched label is fragmented into highlight spans, so assert on the
    // filtered option set rather than the contiguous label text.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(options[0]!).getByText(/planning/)).toBeInTheDocument();
    expect(screen.queryByText("Alpha review")).not.toBeInTheDocument();
  });

  it("shows the currently selected target on the trigger", () => {
    const target = targetFromConversation(ITEMS[0]!);
    const Picker = makePicker();
    render(<Picker target={target} onSelect={vi.fn()} />);
    // Trigger is rendered even while the panel is closed.
    expect(
      within(screen.getByRole("button")).getByText(/Alpha review/),
    ).toBeInTheDocument();
  });

  it("selects the active option on Enter", () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "beta" }),
    );
  });
});
