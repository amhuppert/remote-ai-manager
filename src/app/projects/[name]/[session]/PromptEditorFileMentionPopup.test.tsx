// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromptEditorFileMentionPopup,
  type FileMentionPopupHandle,
} from "./PromptEditorFileMentionPopup";

const mockFiles = [
  { path: "src/index.ts" },
  { path: "src/components/Button.tsx" },
  { path: "src/components/Modal.tsx" },
];

const { mockUseProjectFilesQuery } = vi.hoisted(() => ({
  mockUseProjectFilesQuery: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
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
    expect(onSelect).toHaveBeenCalledWith("src/components/Modal.tsx");
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
});
