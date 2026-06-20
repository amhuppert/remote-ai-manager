// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createConversationMentionPopup } from "./PromptEditorConversationMentionPopup";
import type {
  ConversationListItem,
  AllConversationsResponse,
} from "@/lib/conversations/schemas";
import type { ConversationMentionPopupHandle } from "./PromptEditorConversationMentionPopup";

function makeItem(
  overrides: Partial<ConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "my-app",
    projectPath: overrides.projectPath ?? "/repos/my-app",
    sessionName: overrides.sessionName ?? "main",
    worktreePath: overrides.worktreePath ?? "/repos/my-app/.worktrees/main",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? null,
    summary: overrides.summary ?? null,
    firstPromptSnippet: overrides.firstPromptSnippet ?? null,
    backend: overrides.backend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    debugLogPath: overrides.debugLogPath ?? null,
    status: overrides.status ?? "new",
    lastActivityAt: overrides.lastActivityAt ?? "2024-01-01T00:00:00Z",
    archived: overrides.archived ?? false,
  };
}

interface FakeQueryState {
  data: AllConversationsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: { message: string } | null;
  /** Records the last params passed by the production code. */
  lastCallParams: { includeArchived: boolean } | null;
}

function makeFakeHook(initial: FakeQueryState) {
  const state = { ...initial };
  const useFake = (params: { includeArchived: boolean }) => {
    state.lastCallParams = params;
    return {
      data: state.data,
      isLoading: state.isLoading,
      isError: state.isError,
      error: state.error ?? null,
    };
  };
  return { useFake, state };
}

function makeResponse(items: ConversationListItem[]): AllConversationsResponse {
  return { items, totalCount: items.length };
}

function PopupHarness({
  Popup,
  query,
  onSelect,
  handleRef,
}: {
  Popup: ReturnType<typeof createConversationMentionPopup>;
  query: string;
  onSelect: (sel: unknown) => void;
  handleRef: React.MutableRefObject<ConversationMentionPopupHandle | null>;
}) {
  return (
    <Popup
      ref={(handle) => {
        handleRef.current = handle;
      }}
      query={query}
      currentProjectName="my-app"
      currentConversationId="conv-self"
      onSelect={onSelect}
    />
  );
}

describe("PromptEditorConversationMentionPopup", () => {
  it("renders items from the query and filters by query string", () => {
    const items = [
      makeItem({
        conversationId: "c1",
        conversationName: "Refactor parser",
      }),
      makeItem({
        conversationId: "c2",
        conversationName: "Login flow",
      }),
    ];
    const { useFake } = makeFakeHook({
      data: makeResponse(items),
      isLoading: false,
      isError: false,
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    const { container } = render(
      <PopupHarness
        Popup={Popup}
        query="parser"
        onSelect={() => {}}
        handleRef={handleRef}
      />,
    );

    expect(container.textContent).toContain("Refactor parser");
    expect(container.textContent).not.toContain("Login flow");
  });

  it("excludes the current conversation from results", () => {
    const items = [
      makeItem({
        conversationId: "conv-self",
        conversationName: "Self ref",
      }),
      makeItem({ conversationId: "c1", conversationName: "Other" }),
    ];
    const { useFake } = makeFakeHook({
      data: makeResponse(items),
      isLoading: false,
      isError: false,
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    render(
      <PopupHarness
        Popup={Popup}
        query=""
        onSelect={() => {}}
        handleRef={handleRef}
      />,
    );

    expect(screen.queryByText("Self ref")).not.toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("ArrowDown moves selection and Enter selects the active item", () => {
    const items = [
      makeItem({ conversationId: "c1", conversationName: "First" }),
      makeItem({ conversationId: "c2", conversationName: "Second" }),
    ];
    const { useFake } = makeFakeHook({
      data: makeResponse(items),
      isLoading: false,
      isError: false,
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const onSelect = vi.fn();
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    render(
      <PopupHarness
        Popup={Popup}
        query=""
        onSelect={onSelect}
        handleRef={handleRef}
      />,
    );

    act(() => {
      handleRef.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
    });
    act(() => {
      handleRef.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c2",
      conversationName: "Second",
    });
  });

  it("Alt+A toggles includeArchived and refetches with the new value", () => {
    const items = [makeItem({ conversationId: "c1", conversationName: "X" })];
    const { useFake, state } = makeFakeHook({
      data: makeResponse(items),
      isLoading: false,
      isError: false,
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    render(
      <PopupHarness
        Popup={Popup}
        query=""
        onSelect={() => {}}
        handleRef={handleRef}
      />,
    );

    expect(state.lastCallParams).toEqual({ includeArchived: false });

    act(() => {
      handleRef.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "a", altKey: true }),
      );
    });

    expect(state.lastCallParams).toEqual({ includeArchived: true });
  });

  it("clicking the archived header toggle also flips includeArchived", () => {
    const { useFake, state } = makeFakeHook({
      data: makeResponse([]),
      isLoading: false,
      isError: false,
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    render(
      <PopupHarness
        Popup={Popup}
        query=""
        onSelect={() => {}}
        handleRef={handleRef}
      />,
    );

    expect(state.lastCallParams?.includeArchived).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /archived/i }));
    expect(state.lastCallParams?.includeArchived).toBe(true);
  });

  it("Escape calls onClose, stops propagation, and consumes the event", () => {
    const { useFake } = makeFakeHook({
      data: makeResponse([
        makeItem({ conversationId: "c1", conversationName: "Item" }),
      ]),
      isLoading: false,
      isError: false,
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const onClose = vi.fn();
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    render(
      <Popup
        ref={(handle) => {
          handleRef.current = handle;
        }}
        query=""
        currentProjectName="my-app"
        currentConversationId="conv-self"
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    let consumed: boolean | undefined;
    act(() => {
      consumed = handleRef.current?.handleKeyDown(event);
    });
    expect(consumed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("surfaces query error message in the list", () => {
    const { useFake } = makeFakeHook({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: "boom" },
      lastCallParams: null,
    });
    const Popup = createConversationMentionPopup({
      useAllConversations: useFake,
    });
    const handleRef = {
      current: null as ConversationMentionPopupHandle | null,
    };

    render(
      <PopupHarness
        Popup={Popup}
        query=""
        onSelect={() => {}}
        handleRef={handleRef}
      />,
    );

    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
