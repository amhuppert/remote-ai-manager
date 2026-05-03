// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromptEditorSlashCommandPopup,
  type SlashCommandPopupHandle,
} from "./PromptEditorSlashCommandPopup";
import type { CommandItem } from "@/types";

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

const { mockUseCommandsQuery, mockUseProjectCommandsQuery } = vi.hoisted(
  () => ({
    mockUseCommandsQuery: vi.fn(),
    mockUseProjectCommandsQuery: vi.fn(),
  }),
);

vi.mock("@/lib/queries", () => ({
  useCommandsQuery: mockUseCommandsQuery,
  useProjectCommandsQuery: mockUseProjectCommandsQuery,
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
  mockUseProjectCommandsQuery.mockReturnValue({
    data: { items: [] },
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
    expect(onSelect).toHaveBeenCalledWith("/review");
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
    expect(onSelect.mock.calls[0]?.[0]).not.toBe("/collab");
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
    expect(onSelect).toHaveBeenCalledWith("/kiro:spec-init");
    expect(onShowPlaceholder).toHaveBeenCalledWith("<project-description>");
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
