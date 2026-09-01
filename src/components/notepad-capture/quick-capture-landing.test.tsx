// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import { useSessionDetailStore } from "@/stores/session-detail.store";
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

import VoiceQuickCaptureHost from "./VoiceQuickCaptureHost";

let pathname = "/projects/command-center";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const TRANSCRIPT = "Ship the pill first. Then the retry path.";

let api: FetchFixture;
let notepads: NotepadApiFixture;
let microphone: FakeMicrophone;
let dispatcher: HotkeyDispatcher;
let queryClient: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  pathname = "/projects/command-center";
  useSessionDetailStore.getState().closeNotepad();
  api = installFetchFixture();
  api.json("GET", "/api/voice/health", { available: true });
  api.json("POST", "/api/voice/transcribe", { text: TRANSCRIPT });
  notepads = installNotepadApi(api);
  microphone = installFakeMicrophone();
  dispatcher = createHotkeyDispatcher();
  queryClient = createTestQueryClient();
});

afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().closeNotepad();
  microphone.restore();
  api.restore();
  vi.useRealTimers();
});

function seedFieldNotes(content = "Existing content."): void {
  notepads.put({ id: "np-recent", name: "Field notes", content, revision: 3 });
}

function mountHost(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <HotkeyProvider dispatcher={dispatcher}>
        <VoiceQuickCaptureHost />
      </HotkeyProvider>
    </QueryClientProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function pressHotkey(): Promise<void> {
  await act(async () => {
    dispatcher.invoke("voiceQuickCapture");
  });
  await settle();
}

/** One press, one recording — the capture resolves everything behind it. */
async function pressToRecord(): Promise<void> {
  await pressHotkey();
  await waitFor(() => {
    expect(microphone.startCount()).toBe(1);
  });
}

/** Mount, then record. */
async function startRecording(): Promise<void> {
  mountHost();
  await pressToRecord();
}

/**
 * Record and stop, exactly as the user does: press, talk past the recorder's
 * minimum-duration floor, press again. Nothing is awaited that the user would
 * not have waited through — the destination and its content are read before the
 * microphone opens, so no test has to wait for a cache to fill first.
 */
async function captureOnce(): Promise<void> {
  await startRecording();
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await pressHotkey();
}

function transcribeBody(): FormData | null {
  return api.requestsTo("POST", "/api/voice/transcribe")[0]?.formBody ?? null;
}

function contentWrites() {
  return api.requests.filter(
    (req) =>
      req.method === "POST" &&
      /^\/api\/notepads\/[^/]+\/content$/.test(req.pathname),
  );
}

describe("transcription context from the destination (R25.2)", () => {
  it("sends the destination notepad's current content as context", async () => {
    seedFieldNotes("Existing content.");

    await captureOnce();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    expect(transcribeBody()?.get("context")).toBe("Existing content.");
  });

  it("sends no context when the destination is empty", async () => {
    seedFieldNotes("");

    await captureOnce();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    expect(transcribeBody()?.has("context")).toBe(false);
  });

  it("sends no context when the destination does not exist yet", async () => {
    await captureOnce();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    expect(transcribeBody()?.has("context")).toBe(false);
    // A destination that has to be created is not read first.
    expect(
      api.requests.filter(
        (r) =>
          r.method === "GET" && /^\/api\/notepads\/[^/]+$/.test(r.pathname),
      ),
    ).toHaveLength(0);
  });

  it("bounds the context to the tail of a long destination", async () => {
    seedFieldNotes(`${"x".repeat(9000)} the recent part`);

    await captureOnce();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    const context = transcribeBody()?.get("context");
    expect(typeof context).toBe("string");
    expect(String(context).length).toBeLessThanOrEqual(4000);
    expect(String(context).endsWith("the recent part")).toBe(true);
  });

  it("carries the destination's content as it stands when the audio is sent", async () => {
    seedFieldNotes("Existing content.");
    await startRecording();

    // Someone edits the notepad while the user is still talking. The point of
    // sending context is to transcribe against what the notepad actually says,
    // so the request must carry the edit, not a snapshot from before it.
    notepads.put({
      id: "np-recent",
      content: "Existing content.\n\nAdded while they were talking.",
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    expect(transcribeBody()?.get("context")).toContain(
      "Added while they were talking.",
    );
  });

  it("reads the destination before recording, so a short clip still carries context", async () => {
    seedFieldNotes("Existing content.");

    await startRecording();

    // The content read completes before the microphone opens — a recording
    // stopped the instant it clears the duration floor cannot outrun it.
    expect(api.requestsTo("GET", "/api/notepads/np-recent")).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/voice/transcribe")).toHaveLength(1);
    });
    expect(transcribeBody()?.get("context")).toBe("Existing content.");
  });
});

describe("silent-append landing (R25.1)", () => {
  it("appends the transcription to the resolved destination", async () => {
    seedFieldNotes();

    await captureOnce();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    expect(contentWrites()[0]?.pathname).toBe(
      "/api/notepads/np-recent/content",
    );
    expect(contentWrites()[0]?.jsonBody).toEqual({
      operation: "append",
      content: TRANSCRIPT,
    });
    expect(notepads.read("np-recent")?.content).toBe(
      `Existing content.\n\n${TRANSCRIPT}`,
    );
  });

  it("creates a notepad and lands there when the pool is empty", async () => {
    await captureOnce();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    expect(api.requestsTo("POST", "/api/notepads")[0]?.jsonBody).toEqual({
      scope: "project",
      project: "command-center",
      name: "Inbox",
    });
    expect(contentWrites()[0]?.pathname).toBe(
      "/api/notepads/np-created-1/content",
    );
  });

  it("re-resolves an open notepad the listing no longer has", async () => {
    seedFieldNotes();
    // The session store still points at a notepad the listing no longer has.
    useSessionDetailStore.getState().openNotepad("np-deleted");

    await captureOnce();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    expect(contentWrites()[0]?.pathname).toBe(
      "/api/notepads/np-recent/content",
    );
  });

  it("lands in the notepad it named even when another became more recent", async () => {
    seedFieldNotes();

    await startRecording();
    await screen.findByText(/Field notes/);
    // Another notepad is written while the user is still talking.
    notepads.put({
      id: "np-newer",
      name: "Newer notes",
      content: "Something else",
      updatedAt: "2026-08-31T23:00:00.000Z",
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    // The pill promised Field notes; the words go where they were promised.
    expect(contentWrites()[0]?.pathname).toBe(
      "/api/notepads/np-recent/content",
    );
  });

  it("appends to the notepad that took the promised name mid-recording", async () => {
    // Empty pool: the pill promises a notepad called Inbox that does not exist.
    await startRecording();
    await screen.findByText(/Inbox/);
    // Another surface creates exactly that notepad while the user is talking.
    notepads.put({
      id: "np-inbox",
      name: "Inbox",
      content: "Written elsewhere",
      updatedAt: "2026-08-31T23:00:00.000Z",
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    // The promise was the name, and that notepad holds it: no second Inbox.
    expect(api.requestsTo("POST", "/api/notepads")).toHaveLength(0);
    expect(contentWrites()[0]?.pathname).toBe("/api/notepads/np-inbox/content");
  });

  it("creates the promised name even when another notepad appears mid-recording", async () => {
    await startRecording();
    await screen.findByText(/Inbox/);
    // A notepad the user was never shown becomes the most recent in scope.
    notepads.put({
      id: "np-scratch",
      name: "Scratch",
      content: "Something else",
      updatedAt: "2026-08-31T23:00:00.000Z",
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    expect(api.requestsTo("POST", "/api/notepads")[0]?.jsonBody).toEqual({
      scope: "project",
      project: "command-center",
      name: "Inbox",
    });
    expect(contentWrites()[0]?.pathname).toBe(
      "/api/notepads/np-created-2/content",
    );
  });

  it("keeps the promised name when its holder is deleted between listing and append", async () => {
    await startRecording();
    await screen.findByText(/Inbox/);

    // A notepad takes the promised name mid-capture, and an unrelated notepad
    // becomes the most recent in scope.
    notepads.put({
      id: "np-inbox",
      name: "Inbox",
      content: "Written elsewhere",
      updatedAt: "2026-08-31T22:00:00.000Z",
    });
    notepads.put({
      id: "np-other",
      name: "Other notes",
      content: "Unrelated",
      updatedAt: "2026-08-31T23:00:00.000Z",
    });
    // The holder is deleted after landing read the listing but before the
    // append reached it — the write 404s mid-flight.
    api.reply("POST", "/api/notepads/np-inbox/content", () => {
      notepads.remove("np-inbox");
      return { status: 404, json: { error: "Notepad not found" } };
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(api.requestsTo("POST", "/api/notepads")).toHaveLength(1);
    });
    // Only an id can vanish; the promised name is re-satisfiable, so the retry
    // creates it rather than falling back to a notepad never shown.
    expect(api.requestsTo("POST", "/api/notepads")[0]?.jsonBody).toEqual({
      scope: "project",
      project: "command-center",
      name: "Inbox",
    });
    await waitFor(() => {
      expect(notepads.read("np-created-2")?.content).toBe(TRANSCRIPT);
    });
    expect(notepads.read("np-other")?.content).toBe("Unrelated");
  });

  it("suffixes and names the suffixed notepad when the promised name is taken", async () => {
    await startRecording();
    await screen.findByText(/Inbox/);
    // An archived notepad holds the promised name: names are unique per scope,
    // so the capture cannot land under it and cannot append into it either.
    notepads.put({
      id: "np-archived-inbox",
      name: "Inbox",
      archived: true,
      updatedAt: "2026-08-31T23:00:00.000Z",
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    const suffixed = `Inbox (${new Date().toISOString().slice(0, 10)})`;
    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    expect(api.requestsTo("POST", "/api/notepads")[0]?.jsonBody).toEqual({
      scope: "project",
      project: "command-center",
      name: suffixed,
    });
    // The confirmation names the notepad that actually received the capture.
    const confirmation = await screen.findByRole("status", {
      name: /capture landed/i,
    });
    expect(confirmation.textContent).toContain(suffixed);
  });

  it("re-resolves when the named destination is deleted mid-recording", async () => {
    seedFieldNotes();
    notepads.put({
      id: "np-fallback",
      name: "Fallback notes",
      content: "Older",
      updatedAt: "2026-08-31T09:00:00.000Z",
    });

    await startRecording();
    await screen.findByText(/Field notes/);
    notepads.remove("np-recent");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await pressHotkey();

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(1);
    });
    // Nothing is appended into the deleted notepad, and nothing is lost.
    expect(contentWrites()[0]?.pathname).toBe(
      "/api/notepads/np-fallback/content",
    );
    expect(notepads.read("np-fallback")?.content).toBe(
      `Older\n\n${TRANSCRIPT}`,
    );
  });
});

describe("landing confirmation (R25.1, R25.3)", () => {
  it("names the destination and previews what landed", async () => {
    seedFieldNotes();

    await captureOnce();

    const confirmation = await screen.findByRole("status", {
      name: /capture landed/i,
    });
    expect(confirmation.textContent).toContain("Field notes");
    expect(confirmation.textContent).toContain("Ship the pill first.");
  });

  it("offers Open, which opens the notepad in the right pane", async () => {
    seedFieldNotes();

    await captureOnce();

    await screen.findByRole("status", { name: /capture landed/i });
    await act(async () => {
      screen.getByRole("button", { name: /open/i }).click();
    });

    expect(useSessionDetailStore.getState().openNotepadId).toBe("np-recent");
    expect(useSessionDetailStore.getState().rightPaneTab).toBe("notepad");
  });

  it("offers Undo, which writes the pre-capture content back", async () => {
    seedFieldNotes("Existing content.");

    await captureOnce();

    await screen.findByRole("status", { name: /capture landed/i });
    await act(async () => {
      screen.getByRole("button", { name: /undo/i }).click();
    });

    await waitFor(() => {
      expect(contentWrites()).toHaveLength(2);
    });
    expect(contentWrites()[1]?.jsonBody).toEqual({
      operation: "update",
      content: "Existing content.",
      baseRevision: 4,
    });
    expect(notepads.read("np-recent")?.content).toBe("Existing content.");
  });

  it("declines to undo over a write that landed after the capture", async () => {
    seedFieldNotes("Existing content.");

    await captureOnce();
    await screen.findByRole("status", { name: /capture landed/i });
    // Another writer appends after the capture: the captured fragment is no
    // longer the tail, so restoring a remembered body would destroy their text.
    notepads.put({
      id: "np-recent",
      content: `${notepads.read("np-recent")?.content ?? ""}\n\nAn agent wrote this.`,
      revision: 5,
    });

    await act(async () => {
      screen.getByRole("button", { name: /undo/i }).click();
    });
    await waitFor(() => {
      expect(
        api.requestsTo("GET", "/api/notepads/np-recent").length,
      ).toBeGreaterThan(1);
    });
    await settle();

    expect(contentWrites()).toHaveLength(1);
    expect(notepads.read("np-recent")?.content).toBe(
      `Existing content.\n\n${TRANSCRIPT}\n\nAn agent wrote this.`,
    );
  });

  it("dismisses the confirmation once undone", async () => {
    seedFieldNotes();

    await captureOnce();
    await screen.findByRole("status", { name: /capture landed/i });
    await act(async () => {
      screen.getByRole("button", { name: /undo/i }).click();
    });

    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /capture landed/i })).toBe(
        null,
      );
    });
  });
});
