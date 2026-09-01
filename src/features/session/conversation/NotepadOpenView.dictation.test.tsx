// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { useMultilineVoice, voiceOwnership } from "@/hooks/use-multiline-voice";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { NotepadViewMode } from "@/stores/session-detail/types";
import { createTestQueryClient } from "@/test/component-mocks";
import {
  installFakeMicrophone,
  type FakeMicrophone,
} from "@/test/fake-microphone";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import {
  installNotepadApi,
  type NotepadApiFixture,
} from "@/test/notepad-api-fixture";

import NotepadOpenView from "./NotepadOpenView";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/command-center",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const TRANSCRIPT = "Ship the dictation slice.";
const SEEDED_CONTENT = "alpha bravo";

let api: FetchFixture;
let notepads: NotepadApiFixture;
let microphone: FakeMicrophone;
let dispatcher: HotkeyDispatcher;
let queryClient: QueryClient;

// Tiptap needs Range measurement APIs jsdom does not implement.
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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useSessionDetailStore.getState().resetStore();
  api = installFetchFixture();
  api.json("GET", "/api/voice/health", { available: true });
  api.json("POST", "/api/voice/transcribe", { text: TRANSCRIPT });
  notepads = installNotepadApi(api, [
    { id: "np-a", name: "Field notes", content: SEEDED_CONTENT, revision: 3 },
  ]);
  api.json("GET", /^\/api\/notepads\/[^/]+\/comments$/, { comments: [] });
  microphone = installFakeMicrophone();
  dispatcher = createHotkeyDispatcher();
  queryClient = createTestQueryClient();
});

afterEach(() => {
  cleanup();
  const owner = voiceOwnership.currentId();
  if (owner !== null) voiceOwnership.release(owner);
  microphone.restore();
  api.restore();
  vi.useRealTimers();
});

/**
 * A second real consumer of the app-wide voice ownership — the same hook the
 * composer mounts. Ownership is only honestly exercised by two production
 * consumers: a hand-rolled owner would have to fake the incumbent's release,
 * which is the very behaviour the takeover depends on.
 */
function OtherVoiceSurface(): React.JSX.Element {
  const valueRef = useRef("");
  const voice = useMultilineVoice({
    projectName: "command-center",
    valueRef,
    insertText: () => {},
    focus: () => {},
    isFocused: false,
  });
  return (
    <>
      <button type="button" onClick={voice.toggleRecording}>
        other surface
      </button>
      <span data-testid="other-recording">{String(voice.isRecording)}</span>
    </>
  );
}

function mountOpenView(mode: NotepadViewMode, sibling?: React.ReactNode): void {
  act(() => {
    useSessionDetailStore.getState().setNotepadViewMode(mode);
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HotkeyProvider dispatcher={dispatcher}>
        {sibling}
        <NotepadOpenView
          notepadId="np-a"
          projectName="command-center"
          sessionName="s1"
          conversationId="c1"
          active
        />
      </HotkeyProvider>
    </QueryClientProvider>,
  );
}

/** The record control, once the health probe has answered. */
function recordButton(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: "Voice input" });
}

async function focusEditor(): Promise<void> {
  const input = await screen.findByTestId("notepad-editor-input");
  await act(async () => {
    fireEvent.focusIn(input);
  });
}

/**
 * Paste at the editor's current selection, exactly as the panel's own autosave
 * tests do — the paste both edits the document and leaves the cursor after the
 * pasted text, which is what a cursor-insertion assertion needs.
 */
function pasteIntoEditor(text: string): void {
  const dom = screen.getByTestId("notepad-editor-input");
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      items: [],
    },
  });
  dom.dispatchEvent(event);
}

/** Press record, speak past the recorder's minimum duration, press stop. */
async function dictate(): Promise<void> {
  const button = await recordButton();
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => {
    expect(microphone.startCount()).toBe(1);
  });
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  });
  await waitFor(() => {
    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
  });
}

function contentWrites() {
  return api.requestsTo("POST", "/api/notepads/np-a/content");
}

function transcribeBody(): FormData | null {
  return api.requestsTo("POST", "/api/voice/transcribe")[0]?.formBody ?? null;
}

describe("notepad dictation — control placement (R26.1)", () => {
  it("offers the record control in write mode", async () => {
    mountOpenView("write");

    expect(await recordButton()).toBeTruthy();
  });

  it("offers the record control in split mode", async () => {
    mountOpenView("split");

    expect(await recordButton()).toBeTruthy();
  });

  // Switching layouts from a mounted control, rather than opening straight
  // into read/review: the absence then means the control was dropped, not that
  // the health probe had yet to answer.
  it("drops the record control in read mode", async () => {
    mountOpenView("write");
    await recordButton();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "read" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Voice input" })).toBe(null);
    });
  });

  it("drops the record control in review mode", async () => {
    mountOpenView("write");
    await recordButton();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "review" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Voice input" })).toBe(null);
    });
  });
});

describe("notepad dictation — insertion and persistence (R26.1)", () => {
  it("inserts the transcription at the cursor, not at the end of the notepad", async () => {
    mountOpenView("write");
    await recordButton();
    pasteIntoEditor("MARK ");

    await dictate();

    await waitFor(() => {
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        TRANSCRIPT,
      );
    });
    const text = screen.getByTestId("notepad-editor-input").textContent ?? "";
    expect(text.indexOf(TRANSCRIPT)).toBeGreaterThan(text.indexOf("MARK"));
    expect(text.indexOf(TRANSCRIPT)).toBeLessThan(text.indexOf(SEEDED_CONTENT));
  });

  it("persists the insertion through the ordinary autosave path", async () => {
    mountOpenView("write");
    await recordButton();

    await dictate();
    await waitFor(() => {
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        TRANSCRIPT,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    await waitFor(() => {
      expect(contentWrites().length).toBeGreaterThanOrEqual(1);
    });
    const body = contentWrites()[0]?.jsonBody as {
      operation: string;
      content: string;
      baseRevision: number;
    };
    // The dictated text lands through the same update-with-base-revision write
    // every keystroke uses: no dedicated dictation write path.
    expect(body.operation).toBe("update");
    expect(body.baseRevision).toBe(3);
    expect(body.content).toContain(TRANSCRIPT);
    expect(notepads.read("np-a")?.content).toContain(TRANSCRIPT);
    const notepadPosts = api.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.pathname.startsWith("/api/notepads"),
    );
    expect(notepadPosts.map((request) => request.pathname)).toEqual([
      "/api/notepads/np-a/content",
    ]);
  });
});

describe("notepad dictation — transcription context (R26.2)", () => {
  it("supplies the open notepad's current serialized content", async () => {
    mountOpenView("write");
    await recordButton();
    pasteIntoEditor("MARK ");

    await dictate();

    // The live editor content, not the fetched head: the paste is included.
    expect(transcribeBody()?.get("context")).toBe(`MARK ${SEEDED_CONTENT}`);
  });
});

describe("notepad dictation — app-wide voice ownership (R26.3)", () => {
  it("takes the microphone over from another recording voice surface", async () => {
    mountOpenView("write", <OtherVoiceSurface />);
    await recordButton();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "other surface" }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("other-recording").textContent).toBe("true");
    });
    await focusEditor();

    await act(async () => {
      dispatcher.invoke("voiceToggle");
    });

    // The incumbent's own stop path releases the singleton as it cancels, so
    // the press that evicted it also records here rather than being dropped.
    await waitFor(() => {
      expect(screen.getByTestId("other-recording").textContent).toBe("false");
    });
    await waitFor(() => {
      expect(microphone.startCount()).toBe(2);
    });
    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(0);
  });

  it("takes the microphone over from the surface that already owns voice", async () => {
    const incumbentStopped = vi.fn(() => {
      voiceOwnership.release("composer");
    });
    voiceOwnership.claim({ id: "composer", stop: incumbentStopped });
    mountOpenView("write");
    await recordButton();
    await focusEditor();

    await act(async () => {
      dispatcher.invoke("voiceToggle");
    });

    expect(incumbentStopped).toHaveBeenCalled();
    await waitFor(() => {
      expect(microphone.startCount()).toBe(1);
    });
    expect(voiceOwnership.currentId()).not.toBe("composer");
    expect(voiceOwnership.currentId()).not.toBe(null);
  });

  it("yields the microphone when another surface claims voice mid-dictation", async () => {
    mountOpenView("write");
    await recordButton();
    await focusEditor();
    await act(async () => {
      dispatcher.invoke("voiceToggle");
    });
    await waitFor(() => {
      expect(microphone.startCount()).toBe(1);
    });

    await act(async () => {
      voiceOwnership.claim({ id: "composer", stop: () => {} });
    });

    expect(microphone.openTrackCount()).toBe(0);
    expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(0);
  });

  it("does not fire dictation while the notepad editor is unfocused", async () => {
    mountOpenView("write");
    await recordButton();

    let invoked = true;
    await act(async () => {
      invoked = dispatcher.invoke("voiceToggle");
    });

    expect(invoked).toBe(false);
    expect(microphone.startCount()).toBe(0);
  });
});
