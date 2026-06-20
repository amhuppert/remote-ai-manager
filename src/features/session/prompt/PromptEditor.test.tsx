// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PromptEditor,
  shouldOpenSlashPopup,
  type PromptEditorHandle,
} from "@/features/session/prompt/PromptEditor";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import type { AgentBackendId } from "@/lib/shared/schemas";

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

// jsdom doesn't implement getClientRects/getBoundingClientRect on
// contenteditable nodes the way Tiptap expects.  Tiptap and ProseMirror
// occasionally call these in DOM-dependent code paths; stub them so the editor
// can mount in tests.
beforeEach(() => {
  if (typeof Range !== "undefined") {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () =>
        ({
          length: 0,
          item: () => null,
          [Symbol.iterator]: function* () {},
        }) as unknown as DOMRectList;
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    }
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  mockUseCommandsQuery.mockReturnValue({
    data: { items: [] },
    isPending: false,
    isError: false,
    error: null,
  });
  mockUseProjectCommandsQuery.mockReturnValue({
    data: undefined,
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

function makeAddImage(
  attachmentId = "att-pasted",
  fileName = "pasted.png",
): (file: File) => Promise<ImageAttachment | null> {
  return async (file) =>
    ({
      id: attachmentId,
      fileName,
      mediaType: file.type,
      base64Data: "",
      previewUrl: `blob:${attachmentId}`,
      sizeBytes: file.size,
    }) satisfies ImageAttachment;
}

function makeFile(name = "x.png", type = "image/png"): File {
  return new File(["payload"], name, { type });
}

function buildClipboard(files: File[]): {
  items: DataTransferItem[];
  files: File[];
  getData: () => string;
  types: string[];
} {
  const items = files.map(
    (f) =>
      ({
        kind: "file",
        type: f.type,
        getAsFile: () => f,
      }) as unknown as DataTransferItem,
  );
  return {
    items,
    files,
    getData: () => "",
    types: [],
  };
}

describe("PromptEditor", () => {
  it("renders an editable contenteditable surface", () => {
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const content = container.querySelector(".prompt-editor__content");
    expect(content).not.toBeNull();
    const pm = container.querySelector(".ProseMirror");
    expect(pm?.getAttribute("contenteditable")).toBe("true");
  });

  it("renders the initial value into the editor doc", () => {
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value="hello world"
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const pm = container.querySelector(".ProseMirror");
    expect(pm?.textContent).toBe("hello world");
  });

  it("disables editing when disabled prop is true", () => {
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
        disabled
      />,
    );
    const pm = container.querySelector(".ProseMirror");
    expect(pm?.getAttribute("contenteditable")).toBe("false");
  });

  it("does NOT call onSubmit when plain Enter is pressed", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value="hi"
        onChange={() => {}}
        onSubmit={onSubmit}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    fireEvent.keyDown(pm, { key: "Enter", shiftKey: false });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does NOT call onSubmit when Shift+Enter is pressed", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value="hi"
        onChange={() => {}}
        onSubmit={onSubmit}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    fireEvent.keyDown(pm, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit when Ctrl+Enter is pressed", () => {
    const onSubmit = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const { container } = render(
      <PromptEditor
        ref={ref}
        conversationId="conv-1"
        value="hi"
        onChange={() => {}}
        onSubmit={onSubmit}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    act(() => {
      ref.current?.focus();
    });
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    fireEvent.keyDown(pm, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("inserts a chip and forwards the file when an image is pasted", async () => {
    const onAddImage = vi.fn(makeAddImage("att-paste-1"));
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={onAddImage}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    const file = makeFile("paste.png");
    const clip = buildClipboard([file]);

    await act(async () => {
      fireEvent.paste(pm, {
        clipboardData: {
          items: clip.items,
          files: clip.files,
          types: clip.types,
          getData: clip.getData,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAddImage).toHaveBeenCalledTimes(1);
    expect(onAddImage.mock.calls[0]?.[0]).toBe(file);
    const chip = container.querySelector("[data-attachment-id]");
    expect(chip).not.toBeNull();
  });

  it("does NOT insert a chip when onAddImage rejects (returns null)", async () => {
    const onAddImage = vi.fn(async () => null);
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={onAddImage}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    const file = makeFile();
    const clip = buildClipboard([file]);

    await act(async () => {
      fireEvent.paste(pm, {
        clipboardData: {
          items: clip.items,
          files: clip.files,
          types: clip.types,
          getData: clip.getData,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAddImage).toHaveBeenCalledTimes(1);
    const chip = container.querySelector("[data-attachment-id]");
    expect(chip).toBeNull();
  });

  it("ignores non-image paste payloads", async () => {
    const onAddImage = vi.fn();
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={onAddImage}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    fireEvent.paste(pm, {
      clipboardData: {
        items: [],
        files: [],
        getData: (type: string) => (type === "text/plain" ? "plain text" : ""),
      },
    });
    expect(onAddImage).not.toHaveBeenCalled();
  });

  it("exposes an imperative handle that serializes the current doc", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { container } = render(
      <PromptEditor
        ref={ref}
        conversationId="conv-1"
        value="hello"
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    expect(ref.current).not.toBeNull();
    const result = ref.current!.serialize([]);
    expect(result.prompt).toBe("hello");
    expect(result.images).toEqual([]);
    // Ensure the editor mounted (sanity check)
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
  });

  it("exposes a clear() method on the imperative handle", () => {
    const ref = createRef<PromptEditorHandle>();
    render(
      <PromptEditor
        ref={ref}
        conversationId="conv-1"
        value="hello"
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
      />,
    );
    act(() => {
      ref.current!.clear();
    });
    const result = ref.current!.serialize([]);
    expect(result.prompt).toBe("");
  });

  it("invokes onInlineMarkersChange with attachment ids when chips are inserted", async () => {
    const onInlineMarkersChange = vi.fn();
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage("att-marker-a")}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
        onInlineMarkersChange={onInlineMarkersChange}
      />,
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    const file = makeFile("paste.png");
    const clip = buildClipboard([file]);

    await act(async () => {
      fireEvent.paste(pm, {
        clipboardData: {
          items: clip.items,
          files: clip.files,
          types: clip.types,
          getData: clip.getData,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onInlineMarkersChange).toHaveBeenCalled();
    const lastCall =
      onInlineMarkersChange.mock.calls[
        onInlineMarkersChange.mock.calls.length - 1
      ];
    expect(lastCall?.[0]).toEqual(["att-marker-a"]);
  });

  it("does not invoke onInlineMarkersChange when the marker set is unchanged", async () => {
    const onInlineMarkersChange = vi.fn();
    render(
      <PromptEditor
        conversationId="conv-1"
        value="hello"
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
        onInlineMarkersChange={onInlineMarkersChange}
      />,
    );
    expect(onInlineMarkersChange).not.toHaveBeenCalled();
  });

  it("renders the placeholder via Tiptap's data-placeholder attribute", () => {
    const { container } = render(
      <PromptEditor
        conversationId="conv-1"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        pendingImages={[]}
        onAddImage={makeAddImage()}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
        placeholder="Type something…"
      />,
    );
    const placeholder = container.querySelector(
      ".ProseMirror p.is-editor-empty",
    );
    expect(placeholder?.getAttribute("data-placeholder")).toBe(
      "Type something…",
    );
  });
});

describe("shouldOpenSlashPopup", () => {
  it("opens the $ skills trigger only on the Codex backend", () => {
    expect(shouldOpenSlashPopup("$", "codex")).toBe(true);
    expect(shouldOpenSlashPopup("$", "claude")).toBe(false);
    expect(shouldOpenSlashPopup("$", undefined)).toBe(false);
  });

  it("opens the / command trigger on every backend", () => {
    expect(shouldOpenSlashPopup("/", "codex")).toBe(true);
    expect(shouldOpenSlashPopup("/", "claude")).toBe(true);
    expect(shouldOpenSlashPopup("/", undefined)).toBe(true);
  });
});

describe("PromptEditor — backend-dependent slash/skill triggers", () => {
  function editorTree(
    backend: AgentBackendId,
    ref: React.RefObject<PromptEditorHandle | null>,
    client: QueryClient,
  ) {
    return (
      <QueryClientProvider client={client}>
        <PromptEditor
          ref={ref}
          conversationId="conv-1"
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          pendingImages={[]}
          onAddImage={makeAddImage()}
          onRemoveImage={() => {}}
          cumulativeImageCount={0}
          projectName="proj"
          sessionName="sess"
          backend={backend}
        />
      </QueryClientProvider>
    );
  }

  async function typeTrigger(
    ref: React.RefObject<PromptEditorHandle | null>,
    char: string,
  ) {
    await act(async () => {
      ref.current?.editor?.chain().focus().insertContent(char).run();
      await Promise.resolve();
    });
  }

  it("does not open a popup when typing $ on the Claude backend", async () => {
    const ref = createRef<PromptEditorHandle>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(editorTree("claude", ref, client));
    await typeTrigger(ref, "$");
    expect(container.textContent).not.toContain("Skills");
  });

  it("opens the Skills popup when typing $ on the Codex backend", async () => {
    const ref = createRef<PromptEditorHandle>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(editorTree("codex", ref, client));
    await typeTrigger(ref, "$");
    await waitFor(() => {
      expect(container.textContent).toContain("Skills");
    });
  });

  it("opens the Commands popup when typing / on the Codex backend", async () => {
    const ref = createRef<PromptEditorHandle>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(editorTree("codex", ref, client));
    await typeTrigger(ref, "/");
    await waitFor(() => {
      expect(container.textContent).toContain("Commands");
    });
  });

  // Regression: the editor is created once and never rebuilt. Toggling the
  // backend (before the first message) or the conversation's stored backend
  // loading after mount (mid-conversation) must still enable the $ skills
  // trigger without recreating the editor.
  it("enables the $ trigger after the backend switches from Claude to Codex", async () => {
    const ref = createRef<PromptEditorHandle>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, rerender } = render(editorTree("claude", ref, client));
    const editorBefore = ref.current?.editor;

    await act(async () => {
      rerender(editorTree("codex", ref, client));
      await Promise.resolve();
    });

    // The same editor instance is reused (not recreated) across the switch.
    expect(ref.current?.editor).toBe(editorBefore);

    await typeTrigger(ref, "$");
    await waitFor(() => {
      expect(container.textContent).toContain("Skills");
    });
  });

  it("still submits with Ctrl+Enter after typing $ on the Claude backend", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <PromptEditor
          ref={ref}
          conversationId="conv-1"
          value=""
          onChange={() => {}}
          onSubmit={onSubmit}
          pendingImages={[]}
          onAddImage={makeAddImage()}
          onRemoveImage={() => {}}
          cumulativeImageCount={0}
          projectName="proj"
          sessionName="sess"
          backend="claude"
        />
      </QueryClientProvider>,
    );
    await typeTrigger(ref, "$cost");
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    fireEvent.keyDown(pm, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the $ trigger after the backend switches from Codex to Claude", async () => {
    const ref = createRef<PromptEditorHandle>();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, rerender } = render(editorTree("codex", ref, client));

    await act(async () => {
      rerender(editorTree("claude", ref, client));
      await Promise.resolve();
    });

    await typeTrigger(ref, "$");
    expect(container.textContent).not.toContain("Skills");
  });
});
