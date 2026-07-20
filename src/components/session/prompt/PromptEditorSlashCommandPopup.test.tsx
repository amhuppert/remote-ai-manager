// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromptEditorSlashCommandPopup,
  type SlashCommandPopupHandle,
} from "@/components/session/prompt/PromptEditorSlashCommandPopup";
import type { CommandItem } from "@/lib/commands/schemas";
const mockCommands: CommandItem[] = [
  {
    name: "/commit",
    description: "Create a commit",
    type: "command",
    source: "project",
  },
  {
    name: "/review",
    description: "Review changes",
    type: "command",
    source: "project",
  },
  {
    name: "/kiro:spec-init",
    description: "Initialize a spec",
    argumentHint: "<project-description>",
    type: "skill",
    source: "user",
  },
];

const mockProjectCommands: CommandItem[] = [
  {
    name: "/deploy",
    description: "Deploy from the project root",
    type: "command",
    source: "project",
  },
];

const {
  mockUseCommandsQuery,
  mockUseProjectCommandsQuery,
  mockUseAgentCapabilityViewQuery,
} = vi.hoisted(() => ({
  mockUseCommandsQuery: vi.fn(),
  mockUseProjectCommandsQuery: vi.fn(),
  mockUseAgentCapabilityViewQuery: vi.fn(),
}));

vi.mock("@/lib/commands/queries", () => ({
  useCommandsQuery: mockUseCommandsQuery,
  useProjectCommandsQuery: mockUseProjectCommandsQuery,
}));

vi.mock("@/hooks/use-agent-capabilities", () => ({
  useAgentCapabilityViewQuery: mockUseAgentCapabilityViewQuery,
}));

function renderPopup(
  overrides: Partial<
    React.ComponentPropsWithoutRef<typeof PromptEditorSlashCommandPopup>
  > = {},
  ref?: React.RefObject<SlashCommandPopupHandle | null>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PromptEditorSlashCommandPopup
        ref={ref}
        query=""
        triggerChar="/"
        projectName="proj"
        sessionName="sess"
        conversationId="conv"
        backend="claude"
        onSelect={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseCommandsQuery.mockImplementation(
    (
      _projectName: string,
      _sessionName: string,
      _backend: string,
      options?: { enabled?: boolean },
    ) =>
      options?.enabled === false
        ? { data: undefined, isPending: false, isError: false, error: null }
        : {
            data: { items: mockCommands },
            isPending: false,
            isError: false,
            error: null,
          },
  );
  mockUseProjectCommandsQuery.mockImplementation(
    (
      _projectName: string,
      _backend: string,
      options?: { enabled?: boolean },
    ) =>
      options?.enabled === false
        ? { data: undefined, isPending: false, isError: false, error: null }
        : {
            data: { items: mockProjectCommands },
            isPending: false,
            isError: false,
            error: null,
          },
  );
  mockUseAgentCapabilityViewQuery.mockReturnValue({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("PromptEditorSlashCommandPopup", () => {
  it("renders fetched commands plus the native built-ins", async () => {
    await act(async () => {
      renderPopup();
    });
    expect(screen.getByText("/collab")).toBeInTheDocument();
    expect(screen.getByText("/spec")).toBeInTheDocument();
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/review")).toBeInTheDocument();
  });

  it("keeps native /spec authoritative when discovery returns a project command with the same name", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: {
        items: [
          ...mockCommands,
          {
            name: "/spec",
            description: "Project-local spec command",
            type: "command",
            source: "project",
          },
        ],
      },
      isPending: false,
      isError: false,
      error: null,
    });
    const onSelect = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();

    await act(async () => {
      renderPopup({ query: "spec", onSelect }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "/spec",
        source: "built-in",
        description: "Author a durable native Command Center spec.",
        argumentHint: "<what-to-specify>",
      }),
    );
    expect(screen.queryByText("Project-local spec command")).toBeNull();
  });

  it("filters by query", async () => {
    await act(async () => {
      renderPopup({ query: "rev" });
    });
    expect(
      screen.getByText((_, el) => el?.textContent === "/review"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText((_, el) => el?.textContent === "/commit"),
    ).toBeNull();
  });

  it("Enter selects the active item via the keydown handle", async () => {
    const onSelect = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ query: "rev", onSelect }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "/review",
        trigger: "/",
        kind: "command",
        source: "project",
        description: "Review changes",
      }),
    );
  });

  it("ArrowDown advances active index, Enter selects", async () => {
    const onSelect = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ query: "", onSelect }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    // First sorted item is /align; ArrowDown moves off it before Enter selects.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.name).not.toBe("/align");
  });

  it("calls onShowPlaceholder when selecting an item with argumentHint", async () => {
    const onSelect = vi.fn();
    const onShowPlaceholder = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ query: "kiro", onSelect, onShowPlaceholder }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "/kiro:spec-init",
        trigger: "/",
        kind: "skill",
        source: "user",
        argumentHint: "<project-description>",
      }),
    );
    expect(onShowPlaceholder).toHaveBeenCalledWith("<project-description>");
  });

  it("hides plugin commands when the plugins cascade marks them disabled", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: {
        items: [
          {
            name: "/ai-resources:cmd",
            description: "Plugin command",
            type: "command",
            source: "ai-resources",
          },
          {
            name: "/commit",
            description: "Create a commit",
            type: "command",
            source: "project",
          },
        ],
      },
      isPending: false,
      isError: false,
      error: null,
    });
    mockUseAgentCapabilityViewQuery.mockImplementation(
      (_scope, cascadeKind) => {
        if (cascadeKind === "claude-plugins") {
          return {
            data: {
              level: "conversation",
              projectName: "proj",
              sessionName: "sess",
              conversationId: "conv",
              cascadeKind: "claude-plugins",
              backend: "claude",
              items: [
                {
                  itemId: "ai-resources@ai-resources",
                  displayName: "ai-resources",
                  backend: "claude",
                  capabilityKind: "plugin",
                  cascadeKind: "claude-plugins",
                  source: {
                    kind: "plugin",
                    pluginId: "ai-resources@ai-resources",
                  },
                  nativeDefault: { enabled: true },
                  ownEffectiveState: { enabled: false, originLayer: "global" },
                  effectiveState: { enabled: false, originLayer: "global" },
                  originLayer: "global",
                  runtimeVisibility: "runtime-visible",
                  runtimeEmittable: true,
                  stale: false,
                  applyStatus: "none",
                  diagnostics: [],
                },
              ],
              diagnostics: [],
              effectiveHash: "h",
            },
            isPending: false,
            isError: false,
            error: null,
          };
        }
        return {
          data: undefined,
          isPending: false,
          isError: false,
          error: null,
        };
      },
    );
    await act(async () => {
      renderPopup();
    });
    expect(screen.queryByText("/ai-resources:cmd")).toBeNull();
    expect(screen.getByText("/commit")).toBeInTheDocument();
  });

  it("lists /commit and /merge built-ins with descriptions and argument hints", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: { items: [] },
      isPending: false,
      isError: false,
      error: null,
    });
    await act(async () => {
      renderPopup();
    });
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/merge")).toBeInTheDocument();
    expect(
      screen.getByText(/commit session changes with an agent-written message/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/smart-merge the session/i)).toBeInTheDocument();
  });

  it("selecting the /commit built-in inserts the command ready for hint text", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: { items: [] },
      isPending: false,
      isError: false,
      error: null,
    });
    const onSelect = vi.fn();
    const onShowPlaceholder = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ query: "commit", onSelect, onShowPlaceholder }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "/commit",
        trigger: "/",
        kind: "command",
        source: "built-in",
        argumentHint: expect.any(String),
      }),
    );
    expect(onShowPlaceholder).toHaveBeenCalledWith(expect.any(String));
  });

  it("selecting the /merge built-in inserts the command ready for hint text", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: { items: [] },
      isPending: false,
      isError: false,
      error: null,
    });
    const onSelect = vi.fn();
    const onShowPlaceholder = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ query: "merge", onSelect, onShowPlaceholder }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "/merge",
        trigger: "/",
        kind: "command",
        source: "built-in",
        argumentHint: expect.any(String),
      }),
    );
    expect(onShowPlaceholder).toHaveBeenCalledWith(expect.any(String));
  });

  it("lists the /ticket built-in with a command badge", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: { items: [] },
      isPending: false,
      isError: false,
      error: null,
    });
    await act(async () => {
      renderPopup({ query: "ticket" });
    });
    expect(
      screen.getByText((_, el) => el?.textContent === "/ticket"),
    ).toBeInTheDocument();
    expect(screen.getByText("command")).toBeInTheDocument();
    expect(
      screen.getByText(/create a ticket from this conversation/i),
    ).toBeInTheDocument();
  });

  it("selecting the /ticket built-in inserts the command ready for hint text", async () => {
    mockUseCommandsQuery.mockReturnValue({
      data: { items: [] },
      isPending: false,
      isError: false,
      error: null,
    });
    const onSelect = vi.fn();
    const onShowPlaceholder = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ query: "ticket", onSelect, onShowPlaceholder }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "/ticket",
        trigger: "/",
        kind: "command",
        source: "built-in",
        argumentHint: expect.any(String),
      }),
    );
    expect(onShowPlaceholder).toHaveBeenCalledWith(expect.any(String));
  });

  it("hides the /ticket built-in in workflow-managed lane conversations", async () => {
    // A gated iteration/validator lane mounts the composer; /ticket must not
    // be advertised there (the server rejects it for lanes).
    mockUseCommandsQuery.mockReturnValue({
      data: { items: [] },
      isPending: false,
      isError: false,
      error: null,
    });
    await act(async () => {
      renderPopup({ isWorkflowManagedConversation: true });
    });
    expect(screen.queryByText("/ticket")).toBeNull();
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/collab")).toBeInTheDocument();
  });

  it("hides the /ticket built-in on the Codex backend in workflow-managed lane conversations", async () => {
    await act(async () => {
      renderPopup({ backend: "codex", isWorkflowManagedConversation: true });
    });
    expect(screen.queryByText("/ticket")).toBeNull();
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/spec")).toBeInTheDocument();
  });

  it("returns false from handleKeyDown for unrelated keys", async () => {
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({}, ref);
    });
    const consumed = ref.current?.handleKeyDown(
      new KeyboardEvent("keydown", { key: "a" }),
    );
    expect(consumed).toBe(false);
  });

  it("Escape calls onClose, stops propagation, and consumes the event", async () => {
    const onClose = vi.fn();
    const ref = createRef<SlashCommandPopupHandle>();
    await act(async () => {
      renderPopup({ onClose }, ref);
    });
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    const consumed = ref.current?.handleKeyDown(event);
    expect(consumed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });
});

describe("PromptEditorSlashCommandPopup (project-level conversations)", () => {
  it("renders project-root commands when no session exists", async () => {
    await act(async () => {
      renderPopup({ sessionName: undefined });
    });
    expect(screen.getByText("/deploy")).toBeInTheDocument();
    expect(screen.queryByText("/review")).toBeNull();
  });

  it("hides session-only built-ins before a session exists", async () => {
    await act(async () => {
      renderPopup({ sessionName: undefined });
    });
    expect(screen.getByText("/spec")).toBeInTheDocument();
    expect(screen.queryByText("/collab")).toBeNull();
    expect(screen.queryByText("/commit")).toBeNull();
    expect(screen.queryByText("/ticket")).toBeNull();
  });

  it("does not fetch session-scoped commands at project scope", async () => {
    await act(async () => {
      renderPopup({ sessionName: undefined });
    });
    expect(mockUseCommandsQuery).toHaveBeenCalledWith(
      "proj",
      undefined,
      "claude",
      { enabled: false },
    );
    expect(mockUseProjectCommandsQuery).toHaveBeenCalledWith("proj", "claude", {
      enabled: true,
    });
  });

  it("filters capabilities via the project-scoped conversation cascade", async () => {
    await act(async () => {
      renderPopup({ sessionName: undefined, conversationId: "plc-1" });
    });
    expect(mockUseAgentCapabilityViewQuery).toHaveBeenCalledWith(
      {
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "plc-1",
      },
      "claude-plugins",
    );
  });

  it("falls back to project-level capabilities before the first conversation exists", async () => {
    await act(async () => {
      renderPopup({ sessionName: undefined, conversationId: undefined });
    });
    expect(mockUseAgentCapabilityViewQuery).toHaveBeenCalledWith(
      { level: "project", projectName: "proj" },
      "claude-plugins",
    );
  });
});
