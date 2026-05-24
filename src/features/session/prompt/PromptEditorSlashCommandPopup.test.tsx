// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromptEditorSlashCommandPopup,
  type SlashCommandPopupHandle,
} from "@/features/session/prompt/PromptEditorSlashCommandPopup";
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

const { mockUseCommandsQuery, mockUseAgentCapabilityViewQuery } = vi.hoisted(
  () => ({
    mockUseCommandsQuery: vi.fn(),
    mockUseAgentCapabilityViewQuery: vi.fn(),
  }),
);

vi.mock("@/lib/commands/queries", () => ({
  useCommandsQuery: mockUseCommandsQuery,
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
  mockUseCommandsQuery.mockReturnValue({
    data: { items: mockCommands },
    isPending: false,
    isError: false,
    error: null,
  });
  mockUseAgentCapabilityViewQuery.mockReturnValue({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("PromptEditorSlashCommandPopup", () => {
  it("renders fetched commands plus the /collab built-in", async () => {
    await act(async () => {
      renderPopup();
    });
    expect(screen.getByText("/collab")).toBeInTheDocument();
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/review")).toBeInTheDocument();
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
    // First sorted item is /collab; ArrowDown moves to next
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.name).not.toBe("/collab");
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
});
