// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromptEditorFileMentionPopup,
  type FileMentionPopupHandle,
} from "@/components/session/prompt/PromptEditorFileMentionPopup";
import { useSessionDetailStore } from "@/stores/session-detail.store";

const mockFiles = [
  { path: "src/index.ts" },
  { path: "src/components/Button.tsx" },
  { path: "src/components/Modal.tsx" },
  { path: "docs/plan.md" },
];

const { mockUseProjectFilesQuery } = vi.hoisted(() => ({
  mockUseProjectFilesQuery: vi.fn(),
}));

vi.mock("@/lib/files/queries", () => ({
  useProjectFilesQuery: mockUseProjectFilesQuery,
}));

function renderPopup(
  overrides: Partial<
    React.ComponentPropsWithoutRef<typeof PromptEditorFileMentionPopup>
  > = {},
  ref?: React.RefObject<FileMentionPopupHandle | null>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PromptEditorFileMentionPopup
        ref={ref}
        query=""
        projectName="proj"
        sessionName="session-x"
        onSelect={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseProjectFilesQuery.mockReturnValue({
    data: { items: mockFiles },
    isLoading: false,
    isError: false,
    error: null,
  });
  Element.prototype.scrollIntoView = vi.fn();
  useSessionDetailStore.getState().resetStore();
});

describe("PromptEditorFileMentionPopup", () => {
  it("renders all files when query is empty", async () => {
    await act(async () => {
      renderPopup();
    });
    expect(
      screen.getByText((_, el) => el?.textContent === "src/index.ts"),
    ).toBeInTheDocument();
  });

  it("filters files by query", async () => {
    await act(async () => {
      renderPopup({ query: "Modal" });
    });
    expect(
      screen.getByText(
        (_, el) => el?.textContent === "src/components/Modal.tsx",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        (_, el) => el?.textContent === "src/components/Button.tsx",
      ),
    ).toBeNull();
  });

  it("Enter selects the active file via keydown handle", async () => {
    const onSelect = vi.fn();
    const ref = createRef<FileMentionPopupHandle>();
    await act(async () => {
      renderPopup({ query: "Modal", onSelect }, ref);
    });
    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith({
      path: "src/components/Modal.tsx",
      basename: "Modal.tsx",
      ext: "tsx",
    });
  });

  it("ArrowDown then Enter selects second item", async () => {
    const onSelect = vi.fn();
    const ref = createRef<FileMentionPopupHandle>();
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
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("returns false for unrelated keys", async () => {
    const ref = createRef<FileMentionPopupHandle>();
    await act(async () => {
      renderPopup({}, ref);
    });
    expect(
      ref.current?.handleKeyDown(new KeyboardEvent("keydown", { key: "x" })),
    ).toBe(false);
  });

  it("returns false on Enter when no items match", async () => {
    const ref = createRef<FileMentionPopupHandle>();
    await act(async () => {
      renderPopup({ query: "zzznotamatch" }, ref);
    });
    expect(
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      ),
    ).toBe(false);
  });

  it("Escape calls onClose, stops propagation, and consumes the event", async () => {
    const onClose = vi.fn();
    const ref = createRef<FileMentionPopupHandle>();
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

  it("opens a Markdown result without inserting it", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      renderPopup({ query: "plan", onSelect, onClose });
    });

    screen
      .getByRole("button", { name: "Open docs/plan.md in Markdown viewer" })
      .click();

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useSessionDetailStore.getState().activeDocPath).toBe("docs/plan.md");
  });

  it("Alt+Enter opens the active Markdown result", async () => {
    const ref = createRef<FileMentionPopupHandle>();
    const onSelect = vi.fn();
    await act(async () => {
      renderPopup({ query: "plan", onSelect }, ref);
    });

    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter", altKey: true }),
      );
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(useSessionDetailStore.getState().activeDocPath).toBe("docs/plan.md");
  });
});

describe("PromptEditorFileMentionPopup (project-level conversations)", () => {
  it("scans the project root when no session exists", async () => {
    await act(async () => {
      renderPopup({ sessionName: undefined });
    });
    expect(mockUseProjectFilesQuery).toHaveBeenCalledWith({
      projectName: "proj",
    });
    expect(
      screen.getByText((_, el) => el?.textContent === "src/index.ts"),
    ).toBeInTheDocument();
  });
});
