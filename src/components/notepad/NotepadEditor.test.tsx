// @vitest-environment jsdom
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { REFERENCE_REGISTRY } from "@/lib/prompt-editor";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import type { NotepadImage } from "@/lib/notepads/schemas";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { NotepadEditor, type NotepadEditorHandle } from "./NotepadEditor";
import { REFERENCE_XML_FIXTURES } from "./reference-xml-fixtures";

beforeEach(() => {
  // Chip labels resolve through React Query; a stubbed 404 keeps the tests
  // offline and exercises the captured-name fallback path.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    ),
  );
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
  vi.unstubAllGlobals();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

interface MountArgs {
  initialContent?: string;
  notepadId?: string;
  onContentChange?: (text: string) => void;
  uploadImage?: (notepadId: string, file: File) => Promise<NotepadImage | null>;
}

function mountEditor(args: MountArgs = {}) {
  const ref = createRef<NotepadEditorHandle>();
  const utils = render(
    <NotepadEditor
      ref={ref}
      notepadId={args.notepadId ?? "np-editor-test"}
      initialContent={args.initialContent ?? ""}
      onContentChange={args.onContentChange ?? (() => {})}
      {...(args.uploadImage ? { uploadImage: args.uploadImage } : {})}
    />,
    { wrapper: createWrapper() },
  );
  const handle = ref.current;
  const editor = handle?.editor;
  if (!handle || !editor) throw new Error("NotepadEditor failed to mount");
  return { ...utils, handle, editor };
}

/**
 * jsdom has no constructible ClipboardEvent carrying data, so a plain Event
 * gets the minimal clipboardData surface the paste handlers read.
 */
function pasteEvent(args: { text?: string; files?: File[] }): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) =>
        type === "text/plain" ? (args.text ?? "") : "",
      items: (args.files ?? []).map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
  return event;
}

function pasteText(editor: Editor, text: string): void {
  editor.commands.focus("end");
  editor.view.pasteText(text, pasteEvent({ text }));
}

function pasteFiles(editor: Editor, files: File[]): void {
  editor.commands.focus("end");
  editor.view.dom.dispatchEvent(pasteEvent({ files }));
}

function countNodes(editor: Editor, nodeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === nodeName) count += 1;
  });
  return count;
}

const NOTEPAD_XML = buildNotepadRefXml({
  notepadId: "np-7f3a",
  name: "Release checklist",
  scope: "project",
  projectName: "command-center",
});

const TICKET_XML = buildTicketRefXml({
  projectName: "command-center",
  ticketNumber: 12,
  title: "Add durable ticket context",
});

function fakeNotepadImage(overrides: Partial<NotepadImage>): NotepadImage {
  return {
    id: "img-1",
    notepadId: "np-editor-test",
    fileName: "shot.png",
    mediaType: "image/png",
    sizeBytes: 4,
    sha256: "a".repeat(64),
    snapshotKey: "np-editor-test/img-1/shot.png",
    createdAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("NotepadEditor registry paste parity", () => {
  it("covers every registered reference kind with a paste fixture", () => {
    expect(Object.keys(REFERENCE_XML_FIXTURES).sort()).toEqual(
      REFERENCE_REGISTRY.map((entry) => entry.type).sort(),
    );
  });

  for (const entry of REFERENCE_REGISTRY) {
    it(`pastes ${entry.type} reference XML to its ${entry.nodeName} chip`, () => {
      const { editor } = mountEditor();
      pasteText(editor, `see ${REFERENCE_XML_FIXTURES[entry.type]} here`);

      expect(countNodes(editor, entry.nodeName)).toBe(1);
      expect(editor.state.doc.textContent).toContain("see");
      expect(editor.state.doc.textContent).toContain("here");
    });
  }

  it("renders a pasted notepad reference as an interactive chip in the DOM", async () => {
    const { editor, findByTestId } = mountEditor();
    pasteText(editor, NOTEPAD_XML);

    expect(await findByTestId("notepad-ref-chip")).toBeInTheDocument();
  });
});

describe("NotepadEditor content round-trip", () => {
  const content = [
    "# plan",
    "",
    `- review ${NOTEPAD_XML}`,
    `- ship ${TICKET_XML}`,
    "",
    "```xml",
    TICKET_XML,
    "```",
    "",
    "[Image: img-9]",
  ].join("\n");

  it("opens canonical text as chips and serializes it back unchanged", () => {
    const { editor, handle } = mountEditor({ initialContent: content });

    expect(countNodes(editor, "notepadMention")).toBe(1);
    expect(countNodes(editor, "ticketMention")).toBe(1);
    expect(countNodes(editor, "notepadImage")).toBe(1);
    // The fenced ticket ref stays literal code, not a third chip.
    expect(countNodes(editor, "codeBlock")).toBe(1);
    expect(handle.serialize()).toBe(content);
  });

  it("reports serialized canonical text through onContentChange on edit", () => {
    const changes: string[] = [];
    const { editor } = mountEditor({
      initialContent: `note ${NOTEPAD_XML}`,
      onContentChange: (text) => changes.push(text),
    });

    editor.commands.focus("end");
    editor.commands.insertContent(" updated");

    expect(changes.at(-1)).toBe(`note ${NOTEPAD_XML} updated`);
  });

  it("replaces the document via setContent without emitting a content change", () => {
    const changes: string[] = [];
    const { handle } = mountEditor({
      initialContent: "before",
      onContentChange: (text) => changes.push(text),
    });

    handle.setContent(`after ${NOTEPAD_XML}`);

    expect(handle.serialize()).toBe(`after ${NOTEPAD_XML}`);
    expect(changes).toEqual([]);
  });
});

describe("NotepadEditor image paste", () => {
  it("uploads the pasted image and inserts its id-addressed chip", async () => {
    const uploads: Array<{ notepadId: string; file: File }> = [];
    const uploadImage = async (
      notepadId: string,
      file: File,
    ): Promise<NotepadImage | null> => {
      uploads.push({ notepadId, file });
      return fakeNotepadImage({ id: "img-77", fileName: "diff-spike.png" });
    };
    const file = new File(["png!"], "diff-spike.png", { type: "image/png" });
    const { editor, handle, findByTestId } = mountEditor({
      notepadId: "np-42",
      uploadImage,
    });

    pasteFiles(editor, [file]);

    await waitFor(() => expect(countNodes(editor, "notepadImage")).toBe(1));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.notepadId).toBe("np-42");
    expect(uploads[0]?.file.name).toBe("diff-spike.png");
    expect(handle.serialize()).toBe("[Image: img-77]");

    const chip = await findByTestId("notepad-image-chip");
    const thumbnail = chip.querySelector("img");
    expect(thumbnail?.getAttribute("src")).toBe(
      "/api/notepads/np-42/images/img-77",
    );
  });

  it("inserts nothing when the upload is refused", async () => {
    const uploadImage = async (): Promise<NotepadImage | null> => null;
    const file = new File(["png!"], "too-big.png", { type: "image/png" });
    const { editor, handle } = mountEditor({ uploadImage });

    pasteFiles(editor, [file]);

    // The refused upload resolves asynchronously; give the handler a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countNodes(editor, "notepadImage")).toBe(0);
    expect(handle.serialize()).toBe("");
  });

  it("still renders the image chip after the notepad is closed and reopened", async () => {
    const uploadImage = async (): Promise<NotepadImage | null> =>
      fakeNotepadImage({ id: "img-88", fileName: "shot.png" });
    const file = new File(["png!"], "shot.png", { type: "image/png" });
    const first = mountEditor({ notepadId: "np-42", uploadImage });

    pasteFiles(first.editor, [file]);
    await waitFor(() =>
      expect(countNodes(first.editor, "notepadImage")).toBe(1),
    );
    const persisted = first.handle.serialize();
    first.unmount();

    const reopened = mountEditor({
      notepadId: "np-42",
      initialContent: persisted,
    });
    expect(countNodes(reopened.editor, "notepadImage")).toBe(1);
    const chip = await reopened.findByTestId("notepad-image-chip");
    expect(chip.querySelector("img")?.getAttribute("src")).toBe(
      "/api/notepads/np-42/images/img-88",
    );
    expect(reopened.handle.serialize()).toBe(persisted);
  });
});
