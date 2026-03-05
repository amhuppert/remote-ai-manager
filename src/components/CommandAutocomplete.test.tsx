// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import {
  CommandAutocomplete,
  type CommandAutocompleteHandle,
} from "./CommandAutocomplete";
import type { CommandItem } from "@/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCommands: CommandItem[] = [
  {
    name: "/commit",
    description: "Create a commit",
    type: "command",
    source: "project",
  },
  {
    name: "/review",
    description: "Review recent changes",
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

vi.mock("@/lib/queries", () => ({
  useCommandsQuery: () => ({
    data: { items: mockCommands },
    isPending: false,
    isError: false,
    error: null,
  }),
  useProjectCommandsQuery: () => ({
    data: { items: mockCommands },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderAutocomplete(
  overrides: Partial<
    React.ComponentPropsWithoutRef<typeof CommandAutocomplete>
  > = {},
  ref?: React.RefObject<CommandAutocompleteHandle | null>,
) {
  const defaultProps = {
    promptText: "/",
    onPromptChange: vi.fn(),
    onPlaceholderChange: vi.fn(),
    projectName: "test-project",
    sessionName: "test-session",
    disabled: false,
    ...overrides,
  };

  return render(<CommandAutocomplete ref={ref} {...defaultProps} />);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

// ===========================================================================
// Tests
// ===========================================================================

describe("CommandAutocomplete", () => {
  it("shows dropdown when promptText starts with /", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    expect(screen.getByText("Commands")).toBeInTheDocument();
  });

  it("does not show dropdown when promptText does not start with /", () => {
    renderAutocomplete({ promptText: "hello" });
    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("does not show dropdown when disabled", () => {
    renderAutocomplete({ promptText: "/", disabled: true });
    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("renders items after fetch", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    // Items are sorted alphabetically by name (all score 100 for empty query)
    expect(screen.getByText("/commit")).toBeInTheDocument();
    expect(screen.getByText("/review")).toBeInTheDocument();
    expect(screen.getByText("/kiro:spec-init")).toBeInTheDocument();
  });

  it("filters items by query", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/rev" });
    });

    // /review should match via prefix
    const items = document.querySelectorAll(".cmd-item");
    expect(items.length).toBe(1);
    expect(items[0]?.querySelector(".cmd-desc")?.textContent).toBe(
      "Review recent changes",
    );
  });

  it("shows 'No matching commands' for unmatched query", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/zzznotfound" });
    });

    expect(screen.getByText("No matching commands")).toBeInTheDocument();
  });

  it("shows item count in header", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("shows keyboard hints in footer", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    expect(screen.getByText("navigate")).toBeInTheDocument();
    expect(screen.getByText("select")).toBeInTheDocument();
    expect(screen.getByText("close")).toBeInTheDocument();
  });

  it("first item is active by default", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    const items = document.querySelectorAll(".cmd-item");
    expect(items[0]?.classList.contains("active")).toBe(true);
  });

  it("ArrowDown moves active index", async () => {
    const ref = createRef<CommandAutocompleteHandle>();

    await act(async () => {
      renderAutocomplete({ promptText: "/" }, ref);
    });

    act(() => {
      ref.current?.handleKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });

    const items = document.querySelectorAll(".cmd-item");
    expect(items[1]?.classList.contains("active")).toBe(true);
  });

  it("ArrowUp moves active index up", async () => {
    const ref = createRef<CommandAutocompleteHandle>();

    await act(async () => {
      renderAutocomplete({ promptText: "/" }, ref);
    });

    // Move down first, then up
    act(() => {
      ref.current?.handleKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    act(() => {
      ref.current?.handleKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });

    const items = document.querySelectorAll(".cmd-item");
    expect(items[0]?.classList.contains("active")).toBe(true);
  });

  it("Enter selects the active item and calls onPromptChange", async () => {
    const onPromptChange = vi.fn();
    const ref = createRef<CommandAutocompleteHandle>();

    await act(async () => {
      renderAutocomplete({ promptText: "/", onPromptChange }, ref);
    });

    const consumed = ref.current?.handleKeyDown({
      key: "Enter",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent);

    expect(consumed).toBe(true);
    // First sorted item (/commit) should be inserted with trailing space
    expect(onPromptChange).toHaveBeenCalledWith("/commit ");
  });

  it("Escape calls onPromptChange with empty string", async () => {
    const onPromptChange = vi.fn();
    const ref = createRef<CommandAutocompleteHandle>();

    await act(async () => {
      renderAutocomplete({ promptText: "/", onPromptChange }, ref);
    });

    const consumed = ref.current?.handleKeyDown({
      key: "Escape",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent);

    expect(consumed).toBe(true);
    expect(onPromptChange).toHaveBeenCalledWith("");
  });

  it("handleKeyDown returns false when dropdown not visible", () => {
    const ref = createRef<CommandAutocompleteHandle>();

    render(
      <CommandAutocomplete
        ref={ref}
        promptText="hello"
        onPromptChange={vi.fn()}
        onPlaceholderChange={vi.fn()}
        projectName="test"
        sessionName="test"
        disabled={false}
      />,
    );

    const consumed = ref.current?.handleKeyDown({
      key: "Enter",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent);

    expect(consumed).toBe(false);
  });

  it("hover updates active item", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    const items = document.querySelectorAll(".cmd-item");
    fireEvent.mouseEnter(items[2]!);

    expect(items[2]?.classList.contains("active")).toBe(true);
  });

  it("selecting item with argumentHint calls onPlaceholderChange", async () => {
    const onPromptChange = vi.fn();
    const onPlaceholderChange = vi.fn();
    const ref = createRef<CommandAutocompleteHandle>();

    await act(async () => {
      renderAutocomplete(
        { promptText: "/kiro", onPromptChange, onPlaceholderChange },
        ref,
      );
    });

    // The filtered list should show kiro:spec-init; select it
    act(() => {
      ref.current?.handleKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });

    expect(onPromptChange).toHaveBeenCalledWith("/kiro:spec-init ");
    expect(onPlaceholderChange).toHaveBeenCalledWith("<project-description>");
  });

  it("click on item selects it", async () => {
    const onPromptChange = vi.fn();

    await act(async () => {
      renderAutocomplete({ promptText: "/", onPromptChange });
    });

    const items = document.querySelectorAll(".cmd-item");
    fireEvent.click(items[0]!);

    // First item is /commit (sorted alphabetically)
    expect(onPromptChange).toHaveBeenCalledWith("/commit ");
  });

  it("displays type badges", async () => {
    await act(async () => {
      renderAutocomplete({ promptText: "/" });
    });

    const badges = document.querySelectorAll(".cmd-badge");
    const types = Array.from(badges).map((b) => b.textContent);
    expect(types).toContain("command");
    expect(types).toContain("skill");
  });

  it("Tab selects the active item like Enter", async () => {
    const onPromptChange = vi.fn();
    const ref = createRef<CommandAutocompleteHandle>();

    await act(async () => {
      renderAutocomplete({ promptText: "/", onPromptChange }, ref);
    });

    const consumed = ref.current?.handleKeyDown({
      key: "Tab",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent);

    expect(consumed).toBe(true);
    expect(onPromptChange).toHaveBeenCalledWith("/commit ");
  });
});
